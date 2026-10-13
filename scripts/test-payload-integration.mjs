#!/usr/bin/env node
import { checkIntegrationDirectories, IntegrationGuardError, readIntegrationConfig } from '../cms/tests/support/integration-config.mjs';

const args=process.argv.slice(2);
if(args[0]==='--matrix') {
  if(args.length!==1) {console.error('payload-functional: unsupported_argument');process.exitCode=1;}
  else {
    const {newFunctionalReport,finishFunctionalReport}=await import('../cms/tests/integration/functional-matrix.mjs');
    const report=newFunctionalReport(null);
    process.exitCode=finishFunctionalReport(report);
    console.log(JSON.stringify(report,null,2));
  }
} else if(args[0]==='--prepare-lease' || args[0]==='--execute') {
  try {
    if(args[0]==='--prepare-lease') {
      if(args.length!==1) throw new IntegrationGuardError('unsupported_argument');
      const {prepareFunctionalLease}=await import('./integration/payload-functional-fixture.mjs');
      const filename=await prepareFunctionalLease(process.env);
      console.log('payload-functional: PREPARED; services not contacted; acceptance INCOMPLETE');
      console.log(`lease: ${filename}`);
    } else {
      if(args.length!==3 || args[1]!=='--lease') throw new IntegrationGuardError('unsupported_argument');
      const {executeFunctionalLease}=await import('./integration/payload-functional-run.mjs');
      const {code,report}=await executeFunctionalLease(args[2],process.env);
      process.exitCode=code;
      console.log(JSON.stringify({status:report.status,preauthorityComplete:report.preauthorityComplete,
        acceptanceComplete:report.acceptanceComplete,passed:report.cases.filter(item=>item.status==='PASS').length,
        failed:report.cases.filter(item=>item.status==='FAIL').length,incomplete:report.cases.filter(item=>item.status==='INCOMPLETE').length}));
    }
  } catch(error) {
    console.error(`payload-functional: ${error instanceof IntegrationGuardError ? error.code : 'functional_preflight_failed'}`);
    process.exitCode=1;
  }
} else {
  try {
    const config = readIntegrationConfig(process.env);
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check-config')) {
      throw new IntegrationGuardError('unsupported_argument');
    }
    await checkIntegrationDirectories(config);
    if (process.argv[2] === '--check-config') {
      console.log('payload-integration: CONFIG_VALID; services not contacted; acceptance NOT_EXECUTED');
    } else {
      // Keep the previous host-side path fail closed. Only the explicitly leased
      // first slice is executable; valid config cannot become complete acceptance.
      console.error('payload-integration: acceptance_suite_not_implemented; preparation must be separate; NOT_EXECUTED');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`payload-integration: ${error instanceof IntegrationGuardError ? error.code : 'preflight_failed'}`);
    process.exitCode = 1;
  }
}
