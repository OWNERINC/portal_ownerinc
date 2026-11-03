#!/usr/bin/env python3
"""Disposable PG16 CI qualification of the real restore adapter.

Uses real archives, roles, auth, ACLs, identities and PostgreSQL transactions.
Admission/witness/application fencing is explicitly NOT qualified by this test.
Only the dedicated CI job opts in; there is no production environment switch.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
from types import SimpleNamespace

REPO=Path(__file__).resolve().parents[2]


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


R=load('recovery_pg',REPO/'ops/payload-production-b0-recovery.py')
runtime=load('recovery_runtime_pg',REPO/'ops/payload-control-runtime.py')
C=load('recovery_ci',REPO/'tests/fixtures/payload-production-recovery-ci.py')


def run(args,data=None):
    return C.run(args,data=data)


def main():
    owned=C.Owned('postgres')
    report=None
    password=secrets.token_hex(24)
    with tempfile.TemporaryDirectory(prefix='pg-',dir=owned.root) as directory:
        fd=os.open(str(Path(directory)/'lease'),os.O_CREAT|os.O_RDWR,0o600)
        if fd!=9:os.dup2(fd,9);os.close(fd)
        import fcntl
        fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:
            environment=C.write(owned.root/'pg.env',('POSTGRES_PASSWORD='+password+'\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust\n').encode())
            name=owned.container('pg',R.PG_IMAGE,options=('--network','none','--env-file',str(environment)),
                command=('postgres','-c','max_prepared_transactions=10'))
            owned.docker('start',name)
            deadline=time.monotonic()+C.budget().window(60)
            while True:
                result=C.run(['/usr/bin/docker','exec',name,'pg_isready','-U','postgres'],timeout=10,ok=False)
                if result.returncode==0:break
                if time.monotonic()>deadline:raise RuntimeError('postgres readiness timeout')
                time.sleep(.2)
            def sql(query,db='postgres'):
                return run(['/usr/bin/docker','exec','-i',name,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],query.encode())
            sql("CREATE ROLE portal_admin LOGIN SUPERUSER; CREATE ROLE portal_api LOGIN PASSWORD '"+password+
                "'; CREATE ROLE portal_cron LOGIN PASSWORD '"+password+"'; CREATE ROLE cms_runtime LOGIN; "
                "CREATE DATABASE portal_qualified OWNER portal_admin; CREATE DATABASE ownerinc_cms; CREATE DATABASE unrelated;")
            sql("CREATE TABLE retained(value text); INSERT INTO retained VALUES ('unrelated preserved');",'unrelated')
            sql("SET ROLE portal_admin; CREATE TABLE sample(id bigserial PRIMARY KEY,value text NOT NULL); "
                "INSERT INTO sample(value) VALUES ('B0'),('nonempty'); CREATE TABLE cms_editor_sessions(id integer PRIMARY KEY); "
                "CREATE TABLE owner_news_authority(singleton boolean,mode text,epoch integer); "
                "INSERT INTO owner_news_authority VALUES(true,'legacy',1); CREATE TABLE owner_news_authority_transitions(id integer); "
                "GRANT USAGE ON SCHEMA public TO portal_api,portal_cron; GRANT SELECT ON sample TO portal_api,portal_cron; "
                "GRANT SELECT ON sample_id_seq TO portal_api,portal_cron; "
                "ALTER DEFAULT PRIVILEGES FOR ROLE portal_admin IN SCHEMA public GRANT SELECT ON TABLES TO portal_api; "
                "REVOKE CONNECT ON DATABASE portal_qualified FROM PUBLIC; GRANT CONNECT ON DATABASE portal_qualified TO portal_api,portal_cron;",
                'portal_qualified')
            h=object.__new__(R.ProductionHost);h.r=runtime;h.pg=name;h.dbname='portal_qualified'
            def bounded(args,**kwargs):
                kwargs['timeout']=C.budget().window(kwargs.get('timeout',120))
                return R.bounded_command(args,**kwargs)
            h.command=bounded;h.boundary=lambda **kw:h.quiet()
            h.environments=lambda:{s:({},password) for s in ('api','cron')}
            h.binding={'portalTarget':{'database':h.sql(R.IDENTITY_SQL)}}
            # The positive is a separately observed, freshly created database,
            # before ANY native DDL. Native-empty and deleted-native are refused.
            state=load('pg_history_state',REPO/'ops/payload-control-state.py')
            eligibility=object.__new__(R.ProductionHost)
            eligibility.r=runtime;eligibility.pg=name;eligibility.dbname=h.dbname;eligibility.command=bounded
            eligibility.intent={'stage':'private_started','cmsTarget':{'database':h.sql(R.IDENTITY_SQL,'ownerinc_cms'),
                'volumes':{'cmsUploads':{'mountpoint':str(owned.root)}}},'creation':{'volumes':{},'containers':{}},
                'b0Acceptance':{'decision':{'qualificationEvidenceSha256':'a'*64,'procedureRevision':'b'*64}}}
            effects={'reservation':0,'capture':0,'restore':0}
            def effect(key):
                def counted(*a,**kw): effects[key]+=1;raise AssertionError('eligibility allowed effects')
                return counted
            eligibility.s=SimpleNamespace(CMS_MIGRATIONS=state.CMS_MIGRATIONS,begin_production_recovery=effect('reservation'))
            eligibility.profile={'cmsCatalogs':[R.sha(R.normalize_dump(eligibility.dump('ownerinc_cms',schema=True)))]+['0'*64]*6}
            eligibility.storage=SimpleNamespace(tree=lambda path:{'.':{}})
            eligibility.authenticate=lambda:None;eligibility.resources=lambda *a:[];eligibility.witness=lambda:'a'*64
            eligibility.artifacts=lambda:contextlib.nullcontext({})
            eligibility.load_contract=lambda raw=None:({'cloneEvidenceSha256':'a'*64,'procedureRevision':'b'*64},'c'*64)
            eligibility.protection=effect('capture');eligibility.restore_database=effect('restore')
            assert eligibility.cms_observation()['prefix']==0
            initial=(REPO/'cms/src/migrations/20261002_181423_owner_news_initial.ts').read_text()
            ddl=initial.split('await db.execute(sql`',1)[1].split('`)',1)[0]
            sql(ddl,'ownerinc_cms')
            sql("INSERT INTO payload_migrations(name,batch) VALUES ('"+state.CMS_MIGRATIONS[0]+"',1); "
                "GRANT USAGE ON SCHEMA public TO cms_runtime; GRANT SELECT,INSERT,DELETE ON news_articles TO cms_runtime;",'ownerinc_cms')
            before_native=eligibility.dump('ownerinc_cms',schema=True)
            eligibility.profile['cmsCatalogs'][1]=R.sha(R.normalize_dump(before_native))
            def native_observations():
                tables=sorted(R.CMS_PREFIXES[1])
                counts=eligibility.sql('SELECT json_build_object('+','.join("'"+t+"',(SELECT count(*) FROM public.\""+t+'\")' for t in tables)+');','ownerinc_cms')
                sequences=eligibility.sql("SELECT coalesce(json_agg(relname ORDER BY relname),'[]') FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S';",'ownerinc_cms')
                return counts,{s:eligibility.sql('SELECT json_build_array(last_value,is_called) FROM public."'+s+'";','ownerinc_cms') for s in sequences}
            unused_observations=native_observations()
            try:eligibility.cms_observation()
            except R.RecoveryError as error:assert str(error)=='recovery_native_history_unprovable'
            else:raise AssertionError('native-empty accepted without prior non-use chain')
            sql("BEGIN; SET LOCAL ROLE cms_runtime; INSERT INTO news_articles(title) VALUES ('valid native UUID article'); COMMIT;",'ownerinc_cms')
            assert sql('SELECT count(*) FROM news_articles;','ownerinc_cms').strip()==b'1'
            sql("BEGIN; SET LOCAL ROLE cms_runtime; DELETE FROM news_articles; COMMIT;",'ownerinc_cms')
            assert sql('SELECT count(*) FROM news_articles;','ownerinc_cms').strip()==b'0'
            assert R.normalize_dump(eligibility.dump('ownerinc_cms',schema=True))==R.normalize_dump(before_native)
            assert native_observations()==unused_observations
            contract_before=R.CONTRACT;R.CONTRACT=str(C.write(owned.root/'contract',b'fixture contract'))
            try:
                try: eligibility.execute(b'never parsed: eligibility must refuse first')
                except R.RecoveryError as error: assert str(error)=='recovery_native_history_unprovable'
                else: raise AssertionError('deleted native history accepted')
            finally: R.CONTRACT=contract_before
            assert effects=={'reservation':0,'capture':0,'restore':0}
            sql("CREATE TABLE retained(value text); INSERT INTO retained VALUES ('CMS preserved');",'ownerinc_cms')
            source=h.database_tuple(); h.authenticate_previous_passwords()
            with tempfile.TemporaryFile() as archive:
                h.dump(output=archive)
                archive.seek(0)
                schema=h.command(['/usr/bin/docker','exec','-i',name,'pg_restore','--schema-only','--file=-'],source=archive)
                assert R.sha(R.normalize_dump(schema))==source['catalogSha256'],'archive/source schema correspondence'
                sql("UPDATE sample SET value='committed candidate'; SELECT nextval('sample_id_seq'); REVOKE SELECT ON sample FROM portal_api;",'portal_qualified')
                previous=h.database_tuple(); assert previous!=source and previous['layoutSha256']==source['layoutSha256']
                restore_count=[0];real_command=h.command
                def commit_then_disconnect(args,**kw):
                    value=real_command(args,**kw)
                    if 'pg_restore' in args and '--single-transaction' in args:
                        restore_count[0]+=1
                        raise ConnectionError('lost completion after real COMMIT')
                    return value
                h.command=commit_then_disconnect
                try:h.restore_database(archive,previous,source)
                except ConnectionError:pass
                else:raise AssertionError('commit gap missing')
                h.command=real_command
                assert h.database_tuple()==source
                # Unsupported archive-external classes must fail BEFORE a
                # protective tuple can authorize restoration of changed rows.
                sql("CREATE PUBLICATION recovery_empty; UPDATE sample SET value='publication must preserve this';",'portal_qualified')
                attempts=[]
                def counted(args,**kw):
                    if 'pg_restore' in args and '--single-transaction' in args:attempts.append(args)
                    return real_command(args,**kw)
                h.command=counted
                for operation in (h.database_tuple,lambda:h.restore_database(archive,previous,source)):
                    try:operation()
                    except R.RecoveryError as error:assert str(error)=='recovery_object_class_unsupported'
                    else:raise AssertionError('unrepresented publication permitted')
                assert attempts==[]
                assert sql("SELECT count(*) FROM pg_publication WHERE pubname='recovery_empty';",'portal_qualified').strip()==b'1'
                assert sql("SELECT count(*) FROM sample WHERE value='publication must preserve this';",'portal_qualified').strip()==b'2'
                h.command=real_command
                sql("DROP PUBLICATION recovery_empty; UPDATE sample SET value=CASE id WHEN 1 THEN 'B0' ELSE 'nonempty' END;",'portal_qualified')
                assert h.database_tuple()==source
                h.restore_database(archive,previous,source)
                assert restore_count[0]==1,'restored-first must not execute again'
                # Kill a real restore backend while its transaction is waiting
                # for an injected test lock. The transaction must leave precisely
                # the sealed previous tuple, and a fresh attempt restores once.
                sql("UPDATE sample SET value='second committed candidate';",'portal_qualified')
                killed_previous=h.database_tuple()
                def wait_backend(application):
                    until=time.monotonic()+C.budget().window(15)
                    while True:
                        raw=sql("SELECT pid FROM pg_stat_activity WHERE application_name='"+application+"' AND wait_event_type='Lock';")
                        if raw.strip():return int(raw.strip())
                        if time.monotonic()>until:raise RuntimeError('expected blocked backend missing')
                        time.sleep(.05)
                def kill_restore(args,**kw):
                    if 'pg_restore' not in args or '--single-transaction' not in args:return real_command(args,**kw)
                    blocker=owned.process(['/usr/bin/docker','exec','-e','PGAPPNAME=recovery-fixture-blocker',name,
                        'psql','-XqAt','-U','postgres','-d','portal_qualified','-c',
                        'BEGIN; LOCK TABLE sample IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60);'],
                        )
                    try:
                        until=time.monotonic()+C.budget().window(15)
                        while b'1' not in sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='recovery-fixture-blocker' AND wait_event='PgSleep';"):
                            if time.monotonic()>until:raise RuntimeError('blocker timeout')
                            time.sleep(.05)
                        process=owned.process(args,stdin=kw['source'])
                        try:
                            pid=wait_backend('ownerinc-b0-recovery')
                            sql('SELECT pg_terminate_backend('+str(pid)+');')
                            assert process.wait(timeout=C.budget().window(15))!=0
                        finally:
                            if process.poll() is None:process.kill();process.wait(timeout=C.budget().window(5,.1,cleanup=True))
                    finally:
                        sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='recovery-fixture-blocker';")
                        blocker.wait(timeout=C.budget().window(15))
                    raise R.RecoveryError('recovery_command_failed')
                h.command=kill_restore
                try:h.restore_database(archive,killed_previous,source)
                except R.RecoveryError as error:assert str(error)=='recovery_command_failed'
                else:raise AssertionError('killed transaction unexpectedly succeeded')
                h.command=real_command;h.quiet()
                assert h.database_tuple()==killed_previous,'interrupted transaction changed sealed previous state'
                h.restore_database(archive,killed_previous,source)
                assert h.database_tuple()==source
                sql("BEGIN; INSERT INTO sample(value) VALUES('prepared'); PREPARE TRANSACTION 'recovery-fixture-prepared';",'portal_qualified')
                try:h.quiet()
                except R.RecoveryError as error:assert str(error)=='recovery_database_busy'
                else:raise AssertionError('prepared transaction accepted')
                sql("ROLLBACK PREPARED 'recovery-fixture-prepared';",'portal_qualified')
                # nextval is nontransactional; restore its exact B0 sequence before
                # subsequent comparisons, as an explicit fixture setup operation.
                sql("SELECT setval('sample_id_seq',2,true);",'portal_qualified')
                # Compatible password rehash must authenticate despite SCRAM salt drift.
                sql("ALTER ROLE portal_api PASSWORD '"+password+"';")
                h.authenticate_previous_passwords();assert h.database_tuple()==source
                h.environments=lambda:{s:({},'incorrect') for s in ('api','cron')}
                try:h.authenticate_previous_passwords()
                except R.RecoveryError:pass
                else:raise AssertionError('incorrect password accepted')
                h.environments=lambda:{s:({},password) for s in ('api','cron')}
                sql("CREATE TABLE unexpected(id integer);",'portal_qualified')
                try:h.restore_database(archive,previous,source)
                except R.RecoveryError as e:assert str(e)=='recovery_database_unknown'
                else:raise AssertionError('unknown layout accepted')
                sql("DROP TABLE unexpected;",'portal_qualified')
                assert h.database_tuple()==source
                sql("CREATE FUNCTION public.unexpected_routine() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 42';",'portal_qualified')
                unsupported=h.database_tuple()
                try:h.restore_database(archive,unsupported,source)
                except R.RecoveryError as error:assert str(error)=='recovery_layout_unsupported'
                else:raise AssertionError('candidate-only routine accepted as same layout')
                assert h.database_tuple()==unsupported
                sql("DROP FUNCTION public.unexpected_routine();",'portal_qualified')
                sql("ALTER DEFAULT PRIVILEGES FOR ROLE portal_admin IN SCHEMA public GRANT SELECT ON TABLES TO cms_runtime;",'portal_qualified')
                unsupported=h.database_tuple()
                try:h.restore_database(archive,unsupported,source)
                except R.RecoveryError as error:assert str(error)=='recovery_layout_unsupported'
                else:raise AssertionError('candidate-only default ACL accepted')
                assert h.database_tuple()==unsupported
                sql("ALTER DEFAULT PRIVILEGES FOR ROLE portal_admin IN SCHEMA public REVOKE SELECT ON TABLES FROM cms_runtime;",'portal_qualified')
                assert h.database_tuple()==source
                assert h.sql("SELECT has_database_privilege('cms_runtime',current_database(),'CONNECT');") is False
                assert sql('SELECT value FROM retained;','ownerinc_cms').strip()==b'CMS preserved'
                assert sql('SELECT value FROM retained;','unrelated').strip()==b'unrelated preserved'
            report={'kind':'production-recovery-pg-ci-v1','postgresMajor':16,'realDatabaseRestore':True,
                'realCommitGapReconciled':True,'compatiblePasswordAuthentication':True,'restoreCount':restore_count[0],
                'realKilledRestoreReconciled':True,'preparedTransactionRefused':True,
                'unsupportedPublicationRefusedBeforeRestore':True,'unsupportedPublicationRestoreCount':len(attempts),
                'deletedNativeUuidHistoryRefused':True,'freshUninitializedPositive':True,'nativeHistoryEffects':effects,
                'cmsAndUnrelatedDatabasePreserved':True,'nativeStorageTests':'separate-required-job-step',
                'productionAdmissionQualified':False,'externalWitnessTransportQualified':False,
                'previousApplicationQualified':False,'exactProductionB0Qualified':False,'liveRecoveryExecuted':False}
        finally:
            os.close(9)
            cleanup=owned.cleanup()
    C.publish_report('postgres',report,cleanup)


if __name__=='__main__':main()
