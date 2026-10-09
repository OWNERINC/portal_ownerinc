// Public registry capture, 2026-10-09. No image layers or secrets were read.
// GET auth.docker.io/token (library/<role>:pull), then registry-1.docker.io
// /v2/library/<role>/manifests/<index>, /manifests/<platform>, /blobs/<config>.
// Only these explicit Linux platforms have grounded Config.Env and config IDs.
export const postgresImage='postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
export const nginxImage='nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752';
const freezeBase=base=>Object.freeze({...base,env:Object.freeze(base.env),
  platforms:Object.freeze(Object.fromEntries(Object.entries(base.platforms).map(([name,value])=>[name,Object.freeze(value)])))});
export const functionalBaseImages=Object.freeze({
  postgres:freezeBase({reference:postgresImage,
    env:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','GOSU_VERSION=1.19','LANG=en_US.utf8',
      'PG_MAJOR=16','PG_VERSION=16.14','PG_SHA256=f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471',
      'DOCKER_PG_LLVM_DEPS=llvm21-dev \t\tclang21','PGDATA=/var/lib/postgresql/data'],
    platforms:{
      amd64:{manifestDigest:'sha256:7a396fd264a2067788b6551122b50f162bf6136312c7fc9d74381cb92c648382',
        configDigest:'sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28'},
      arm64:{manifestDigest:'sha256:7ae1143a9f249af815f056751a122a86d7e44ddce0926f2b227e3d5c434444f4',
        configDigest:'sha256:7e7dbab8d3b431a20793a6d99cb5a6bc84e44914309917f1bf5589a7568cdefd'},
    }}),
  nginx:freezeBase({reference:nginxImage,
    env:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NGINX_VERSION=1.31.3','PKG_RELEASE=1',
      'DYNPKG_RELEASE=1','NJS_VERSION=1.0.0','NJS_RELEASE=1','ACME_VERSION=0.4.1'],
    platforms:{
      amd64:{manifestDigest:'sha256:1d40e3eb3bf4f138de1d67193f2aa5309fcaf343eb5ffadbf5e9439de1eb1ebb',
        configDigest:'sha256:f0ba77f796e57c6fa89ae7f4fdad1665d6fcbd8e3f211535120542b337f9959e'},
      arm64:{manifestDigest:'sha256:1dd3048a04f4b76ebd706c1bbb9df7d9d53b4f8253b32ce14467088c9b5ada0f',
        configDigest:'sha256:28c4e91555d001bb0f6b2796e565bfa75302711a0d6e67c5562eb2f7d54d2483'},
    }}),
});
