# fp-corpus results

- corpus: changesets/changesets, psf/requests, spf13/cobra, GoogleCloudPlatform/microservices-demo, docker/awesome-compose, tldr-pages/tldr, twbs/bootstrap, highlightjs/cdn-release, auth0/node-jsonwebtoken, panva/jose, motdotla/dotenv
- files: 42837/43065 scanned (<2MB text, binary skipped) in 6.9s
- secret-rule hits: 65

Judgement: complete private keys / signed JWTs / sample DB credentials published as test vectors are real-shaped hits (should be redacted), not false positives.

| repo | file | id | line | len | excerpt |
|---|---|---|---|---|---|
| changesets/changesets | scripts/e2e/publish.test.ts | generic-secret-quoted | 103 | 13 | `const CLIENT_AUTH_TOKEN = "publ*********` |
| changesets/changesets | scripts/e2e/publish.test.ts | generic-secret-quoted | 104 | 11 | `nst BAD_CLIENT_AUTH_TOKEN = "wr0n*******` |
| changesets/changesets | scripts/e2e/publish.test.ts | generic-secret-quoted | 379 | 18 | `        password: "Seed**************` |
| changesets/changesets | scripts/e2e/publish.test.ts | generic-secret | 671 | 35 | `secret: chan****************` |
| psf/requests | tests/certs/expired/ca/ca-private.key | private-key | 1 | 1699 | `----****************` |
| psf/requests | tests/certs/expired/server/server.key | private-key | 1 | 1703 | `----****************` |
| psf/requests | tests/certs/mtls/client/client.key | private-key | 1 | 1703 | `----****************` |
| psf/requests | tests/certs/valid/server/server.key | private-key | 1 | 1703 | `----****************` |
| psf/requests | tests/test_requests.py | auth-header | 2223 | 12 | `roxy-Authorization": "Basic dXNl********` |
| docker/awesome-compose | wasmedge-kafka-mysql/README.md | db-connection-url | 56 | 37 | `      DATABASE_URL: mysq****************` |
| docker/awesome-compose | wasmedge-kafka-mysql/compose.yml | db-connection-url | 27 | 37 | `      DATABASE_URL: mysq****************` |
| docker/awesome-compose | wasmedge-mysql-nginx/README.md | db-connection-url | 48 | 37 | `      DATABASE_URL: mysq****************` |
| docker/awesome-compose | wasmedge-mysql-nginx/compose.yml | db-connection-url | 17 | 37 | `      DATABASE_URL: mysq****************` |
| auth0/node-jsonwebtoken | test/dsa-private.pem | private-key | 1 | 2267 | `----****************` |
| auth0/node-jsonwebtoken | test/ecdsa-private.pem | private-key | 9 | 555 | `----****************` |
| auth0/node-jsonwebtoken | test/invalid_exp.tests.js | jwt | 7 | 116 | `var broken_token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/invalid_exp.tests.js | jwt | 17 | 111 | `var broken_token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/invalid_exp.tests.js | jwt | 27 | 116 | `var broken_token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/invalid_exp.tests.js | jwt | 37 | 115 | `var broken_token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/invalid_exp.tests.js | jwt | 47 | 112 | `var broken_token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/jwt.malicious.tests.js | jwt | 22 | 144 | `t maliciousToken = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/jwt.malicious.tests.js | jwt | 28 | 144 | `t maliciousToken = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/prime256v1-private.pem | private-key | 1 | 226 | `----****************` |
| auth0/node-jsonwebtoken | test/priv.pem | private-key | 1 | 1678 | `----****************` |
| auth0/node-jsonwebtoken | test/rsa-private.pem | private-key | 1 | 1678 | `----****************` |
| auth0/node-jsonwebtoken | test/rsa-pss-invalid-salt-length-private.pem | private-key | 1 | 1776 | `----****************` |
| auth0/node-jsonwebtoken | test/rsa-pss-private.pem | private-key | 1 | 1772 | `----****************` |
| auth0/node-jsonwebtoken | test/secp384r1-private.pem | private-key | 1 | 287 | `----****************` |
| auth0/node-jsonwebtoken | test/secp521r1-private.pem | private-key | 1 | 364 | `----****************` |
| auth0/node-jsonwebtoken | test/undefined_secretOrPublickey.tests.js | generic-secret-quoted | 5 | 84 | `var TOKEN = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/verify.tests.js | jwt | 102 | 144 | `    const token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/verify.tests.js | jwt | 187 | 144 | `    const token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/verify.tests.js | jwt | 253 | 144 | `     const token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/verify.tests.js | jwt | 273 | 388 | `     const token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/verify.tests.js | jwt | 284 | 166 | `     const token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/verify.tests.js | jwt | 293 | 166 | `     const token = 'eyJh****************` |
| auth0/node-jsonwebtoken | test/wrong_alg.tests.js | jwt | 13 | 121 | `var TOKEN = 'eyJ0****************` |
| panva/jose | cookbook/jwe.mjs | generic-secret-quoted | 74 | 30 | `      pwd: 'entr****************` |
| panva/jose | docs/jwk/embedded/functions/EmbeddedJWK.md | jwt | 33 | 385 | `  'eyJq****************` |
| panva/jose | docs/jwt/sign/classes/SignJWT.md | private-key | 37 | 1703 | `const pkcs8 = `----****************` |
| panva/jose | docs/jwt/verify/functions/jwtVerify.md | jwt | 43 | 197 | `  'eyJh****************` |
| panva/jose | docs/jwt/verify/functions/jwtVerify.md | jwt | 69 | 496 | `  'eyJh****************` |
| panva/jose | docs/jwt/verify/functions/jwtVerify.md | jwt | 91 | 496 | `  'eyJh****************` |
| panva/jose | docs/key/import/functions/importPKCS8.md | private-key | 34 | 240 | `const pkcs8 = `----****************` |
| panva/jose | src/jwk/embedded.ts | jwt | 25 | 385 | ` *   'eyJq****************` |
| panva/jose | src/jwt/sign.ts | private-key | 49 | 1784 | ` * const pkcs8 = `----****************` |
| panva/jose | src/jwt/verify.ts | jwt | 48 | 197 | ` *   'eyJh****************` |
| panva/jose | src/jwt/verify.ts | jwt | 76 | 496 | ` *   'eyJh****************` |
| panva/jose | src/jwt/verify.ts | jwt | 100 | 496 | ` *   'eyJh****************` |
| panva/jose | src/key/import.ts | private-key | 131 | 252 | ` * const pkcs8 = `----****************` |
| panva/jose | tap/fixtures.ts | private-key | 10 | 142 | `      '----****************` |
| panva/jose | tap/fixtures.ts | private-key | 39 | 288 | `      '----****************` |
| panva/jose | tap/fixtures.ts | private-key | 68 | 365 | `      '----****************` |
| panva/jose | tap/fixtures.ts | private-key | 100 | 467 | `      '----****************` |
| panva/jose | tap/fixtures.ts | private-key | 141 | 2027 | `      '----****************` |
| panva/jose | tap/fixtures.ts | private-key | 205 | 142 | `      '----****************` |
| panva/jose | tap/fixtures.ts | private-key | 221 | 127 | `    pkcs8: `----****************` |
| panva/jose | tap/fixtures.ts | private-key | 264 | 127 | `    pkcs8: `----****************` |
| panva/jose | tap/fixtures.ts | private-key | 321 | 127 | `    pkcs8: `----****************` |
| panva/jose | test/jwt/sign.test.ts | jwt | 24 | 100 | `    'eyJh****************` |
| panva/jose | test/jwt/sign.test.ts | jwt | 35 | 200 | `    'eyJh****************` |
| panva/jose | test/jwt/unsecured.test.ts | jwt | 19 | 56 | `  t.is(jwt, 'eyJh****************` |
| panva/jose | test/jwt/unsecured.test.ts | jwt | 39 | 57 | `nsecuredJWT.decode('eyJh****************` |
| panva/jose | test/util/decode_jwt.test.ts | jwt | 7 | 155 | `    'eyJh****************` |
| motdotla/dotenv | README.md | private-key | 127 | 78 | `PRIVATE_KEY="----****************` |
