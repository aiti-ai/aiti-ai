# fp-corpus results

- corpus: changesets/changesets, psf/requests, spf13/cobra, GoogleCloudPlatform/microservices-demo, docker/awesome-compose, tldr-pages/tldr, twbs/bootstrap, highlightjs/cdn-release, auth0/node-jsonwebtoken, panva/jose, motdotla/dotenv
- files: 42837/43065 scanned (<2MB text, binary skipped) in 5.6s
- secret-rule hits: 162

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
| psf/requests | tests/test_requests.py | keyword-value | 526 | 11 | `        heads = {key: "Mozi*******` |
| psf/requests | tests/test_requests.py | keyword-value | 1421 | 14 | `    cookie = jar.get(key, doma**********` |
| psf/requests | tests/test_requests.py | auth-header | 2223 | 12 | `roxy-Authorization": "Basic dXNl********` |
| GoogleCloudPlatform/microservices-demo | kustomize/components/alloydb/README.md | generic-secret-bare | 100 | 9 | `abase password from the Secret mana*****` |
| GoogleCloudPlatform/microservices-demo | src/adservice/src/main/resources/log4j2.xml | keyword-value | 29 | 28 | ` <KeyValuePair key="logg****************` |
| GoogleCloudPlatform/microservices-demo | src/adservice/src/main/resources/log4j2.xml | keyword-value | 30 | 29 | ` <KeyValuePair key="logg****************` |
| GoogleCloudPlatform/microservices-demo | src/checkoutservice/go.sum | keyword-bare-value | 6 | 14 | `cloud.google.com/go/auth v0.1**********` |
| GoogleCloudPlatform/microservices-demo | src/checkoutservice/go.sum | keyword-bare-value | 8 | 14 | `cloud.google.com/go/auth v0.1**********` |
| GoogleCloudPlatform/microservices-demo | src/emailservice/requirements.txt | keyword-value | 5 | 17 | `cert*************` |
| GoogleCloudPlatform/microservices-demo | src/emailservice/requirements.txt | keyword-value | 98 | 25 | `pyth****************` |
| GoogleCloudPlatform/microservices-demo | src/emailservice/requirements.txt | keyword-value | 106 | 25 | `typi****************` |
| GoogleCloudPlatform/microservices-demo | src/frontend/go.sum | keyword-bare-value | 6 | 14 | `cloud.google.com/go/auth v0.1**********` |
| GoogleCloudPlatform/microservices-demo | src/frontend/go.sum | keyword-bare-value | 8 | 14 | `cloud.google.com/go/auth v0.1**********` |
| GoogleCloudPlatform/microservices-demo | src/productcatalogservice/go.sum | keyword-bare-value | 17 | 14 | `cloud.google.com/go/auth v0.2**********` |
| GoogleCloudPlatform/microservices-demo | src/recommendationservice/requirements.txt | keyword-value | 5 | 17 | `cert*************` |
| GoogleCloudPlatform/microservices-demo | src/recommendationservice/requirements.txt | keyword-value | 77 | 25 | `pyth****************` |
| GoogleCloudPlatform/microservices-demo | src/recommendationservice/requirements.txt | keyword-value | 87 | 25 | `typi****************` |
| GoogleCloudPlatform/microservices-demo | src/shippingservice/go.sum | keyword-bare-value | 6 | 14 | `cloud.google.com/go/auth v0.1**********` |
| GoogleCloudPlatform/microservices-demo | src/shoppingassistantservice/requirements.txt | keyword-value | 19 | 17 | `cert*************` |
| GoogleCloudPlatform/microservices-demo | src/shoppingassistantservice/requirements.txt | keyword-value | 193 | 15 | `pycp***********` |
| GoogleCloudPlatform/microservices-demo | src/shoppingassistantservice/requirements.txt | keyword-value | 220 | 14 | `snif**********` |
| docker/awesome-compose | aspnet-mssql/app/aspnetapp/Views/Home/Index.cshtml | generic-secret-bare | 68 | 8 | `anage User Secrets using Secret Mana****` |
| docker/awesome-compose | wasmedge-kafka-mysql/README.md | db-connection-url | 56 | 37 | `      DATABASE_URL: mysq****************` |
| docker/awesome-compose | wasmedge-kafka-mysql/compose.yml | db-connection-url | 27 | 37 | `      DATABASE_URL: mysq****************` |
| docker/awesome-compose | wasmedge-mysql-nginx/README.md | db-connection-url | 48 | 37 | `      DATABASE_URL: mysq****************` |
| docker/awesome-compose | wasmedge-mysql-nginx/compose.yml | db-connection-url | 17 | 37 | `      DATABASE_URL: mysq****************` |
| tldr-pages/tldr | pages/common/aws-sns.md | keyword-value | 36 | 8 | `-arn {{topic_ARN}} --tags {{Key=tag1****` |
| tldr-pages/tldr | pages/common/aws-sns.md | keyword-bare-value | 36 | 12 | `ARN}} --tags {{Key=tag1_key Key=********` |
| tldr-pages/tldr | pages/common/aws-sns.md | keyword-value | 36 | 16 | `y=tag1_key Key=tag2_key,Valu************` |
| tldr-pages/tldr | pages/common/gh-auth.md | keyword-value | 32 | 14 | `dmin:org,admin:public_key,admi**********` |
| tldr-pages/tldr | pages/common/wait4x-http.md | keyword-bare-value | 20 | 8 | `header "{{Authorization: Bearer toke****` |
| tldr-pages/tldr | pages/common/zapier-init.md | keyword-value | 12 | 125 | `ate]}} {{basic-auth|call****************` |
| tldr-pages/tldr | pages/linux/lrzip.md | generic-secret-bare | 23 | 15 | `ress a file and password prot***********` |
| tldr-pages/tldr | pages/linux/systemd-cryptenroll.md | keyword-value | 37 | 31 | `ot {{empty|password|fido****************` |
| tldr-pages/tldr | pages.de/common/age.md | generic-secret-bare | 7 | 13 | `, die mit einer Passphrase ents*********` |
| tldr-pages/tldr | pages.it/common/aws-sns.md | keyword-value | 36 | 8 | `-arn {{arn_topic}} --tags {{Key=tag1****` |
| tldr-pages/tldr | pages.it/common/aws-sns.md | keyword-bare-value | 36 | 12 | `pic}} --tags {{Key=tag1_key Key=********` |
| tldr-pages/tldr | pages.it/common/aws-sns.md | keyword-value | 36 | 16 | `y=tag1_key Key=tag2_key,Valu************` |
| tldr-pages/tldr | pages.ko/common/aws-sns.md | keyword-value | 36 | 8 | `-arn {{topic_ARN}} --tags {{Key=tag1****` |
| tldr-pages/tldr | pages.ko/common/aws-sns.md | keyword-bare-value | 36 | 12 | `ARN}} --tags {{Key=tag1_key Key=********` |
| tldr-pages/tldr | pages.ko/common/aws-sns.md | keyword-value | 36 | 16 | `y=tag1_key Key=tag2_key,Valu************` |
| tldr-pages/tldr | pages.ko/common/ffuf.md | url-param | 29 | 8 | ` -u {{http://example.com/id?KEY=VALU****` |
| tldr-pages/tldr | pages.ko/common/gh-auth.md | keyword-value | 32 | 14 | `dmin:org,admin:public_key,admi**********` |
| tldr-pages/tldr | pages.ko/common/zapier-init.md | keyword-value | 12 | 125 | `ate]}} {{basic-auth|call****************` |
| tldr-pages/tldr | pages.ko/linux/systemd-cryptenroll.md | keyword-value | 37 | 31 | `ot {{empty|password|fido****************` |
| tldr-pages/tldr | pages.zh/common/gh-auth.md | keyword-value | 32 | 14 | `dmin:org,admin:public_key,admi**********` |
| tldr-pages/tldr | pages.zh/common/zapier-init.md | keyword-value | 12 | 125 | `ate]}} {{basic-auth|call****************` |
| twbs/bootstrap | dist/js/bootstrap.bundle.js | keyword-value | 3797 | 16 | `(items, target, key === ARRO************` |
| twbs/bootstrap | dist/js/bootstrap.bundle.js | keyword-value | 3830 | 9 | `e === 'keyup' && event.key === TAB_*****` |
| twbs/bootstrap | dist/js/bootstrap.bundle.js | keyword-value | 3847 | 12 | `EscapeEvent = event.key === ESCA********` |
| twbs/bootstrap | dist/js/bootstrap.bundle.min.js | keyword-value | 6 | 15 | `ludes(t.key))i=e[t.key===Rs?0***********` |
| twbs/bootstrap | dist/js/bootstrap.esm.js | keyword-value | 1956 | 16 | `(items, target, key === ARRO************` |
| twbs/bootstrap | dist/js/bootstrap.esm.js | keyword-value | 1989 | 9 | `e === 'keyup' && event.key === TAB_*****` |
| twbs/bootstrap | dist/js/bootstrap.esm.js | keyword-value | 2006 | 12 | `EscapeEvent = event.key === ESCA********` |
| twbs/bootstrap | dist/js/bootstrap.esm.min.js | keyword-value | 6 | 21 | `(e.key))n=t[e.key===HOME****************` |
| twbs/bootstrap | dist/js/bootstrap.js | keyword-value | 1979 | 16 | `(items, target, key === ARRO************` |
| twbs/bootstrap | dist/js/bootstrap.js | keyword-value | 2012 | 9 | `e === 'keyup' && event.key === TAB_*****` |
| twbs/bootstrap | dist/js/bootstrap.js | keyword-value | 2029 | 12 | `EscapeEvent = event.key === ESCA********` |
| highlightjs/cdn-release | build/languages/pgsql.min.js | generic-secret-bare | 5 | 11 | ` UNTIL ENCRYPTED|10 PASSWORD CONF*******` |
| highlightjs/cdn-release | build/languages/routeros.min.js | keyword-value | 20 | 85 | `rs|user|vlan|secret|vrrp****************` |
| auth0/node-jsonwebtoken | test/claim-aud.test.js | keyword-value | 120 | 12 | ` verifyWithAudience(token, 'urn:********` |
| auth0/node-jsonwebtoken | test/claim-aud.test.js | keyword-value | 199 | 12 | ` verifyWithAudience(token, 'urn:********` |
| auth0/node-jsonwebtoken | test/claim-aud.test.js | keyword-value | 391 | 12 | ` verifyWithAudience(token, 'urn:********` |
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
| panva/jose | cookbook/jwe.mjs | keyword-value | 83 | 22 | `      salt: '8Q1S****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 101 | 54 | `    encrypted_key: 'd3qN****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 114 | 54 | `    encrypted_key: 'd3qN****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 173 | 32 | `    encrypted_key: '0DJj****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 186 | 32 | `    encrypted_key: '0DJj****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 349 | 43 | `    encrypted_key: 'lJf3****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 362 | 43 | `    encrypted_key: 'lJf3****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 406 | 32 | `    encrypted_key: 'CBI6****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 419 | 32 | `    encrypted_key: 'CBI6****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 466 | 32 | `    encrypted_key: '5vUT****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 479 | 32 | `    encrypted_key: '5vUT****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 524 | 32 | `    encrypted_key: '4Yii****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 538 | 32 | `    encrypted_key: '4Yii****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 583 | 32 | `    encrypted_key: 'jJIc****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 602 | 32 | `    encrypted_key: 'jJIc****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 643 | 32 | `    encrypted_key: '244Y****************` |
| panva/jose | cookbook/jwe.mjs | keyword-value | 662 | 32 | `    encrypted_key: '244Y****************` |
| panva/jose | docs/jwk/embedded/functions/EmbeddedJWK.md | jwt | 33 | 385 | `  'eyJq****************` |
| panva/jose | docs/jwt/decrypt/functions/jwtDecrypt.md | keyword-value | 37 | 21 | `const secret = jose****************` |
| panva/jose | docs/jwt/encrypt/classes/EncryptJWT.md | keyword-value | 15 | 21 | `const secret = jose****************` |
| panva/jose | docs/jwt/sign/classes/SignJWT.md | private-key | 37 | 1703 | `const pkcs8 = `----****************` |
| panva/jose | docs/jwt/verify/functions/jwtVerify.md | jwt | 43 | 197 | `  'eyJh****************` |
| panva/jose | docs/jwt/verify/functions/jwtVerify.md | jwt | 69 | 496 | `  'eyJh****************` |
| panva/jose | docs/jwt/verify/functions/jwtVerify.md | jwt | 91 | 496 | `  'eyJh****************` |
| panva/jose | docs/key/import/functions/importPKCS8.md | private-key | 34 | 240 | `const pkcs8 = `----****************` |
| panva/jose | src/jwk/embedded.ts | jwt | 25 | 385 | ` *   'eyJq****************` |
| panva/jose | src/jwt/decrypt.ts | keyword-value | 41 | 21 | ` * const secret = jose****************` |
| panva/jose | src/jwt/encrypt.ts | keyword-value | 25 | 21 | ` * const secret = jose****************` |
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
| panva/jose | test/jwe/flattened.decrypt.test.ts | keyword-value | 618 | 16 | ` ...jwe, encrypted_key: base************` |
| panva/jose | test/jwe/flattened.decrypt.test.ts | keyword-value | 619 | 16 | ` ...jwe, encrypted_key: base************` |
| panva/jose | test/jwe/general.test.ts | keyword-value | 57 | 17 | ` of [t.context.secret, t.co*************` |
| panva/jose | test/jwe/general.test.ts | keyword-value | 231 | 16 | `ents[0].encrypted_key = base************` |
| panva/jose | test/jwe/general.test.ts | keyword-value | 619 | 16 | `        encrypted_key: base************` |
| panva/jose | test/jwe/integrated_encryption.test.ts | keyword-value | 153 | 10 | `          encrypted_key: enco******` |
| panva/jose | test/jwe/zip.test.ts | keyword-value | 146 | 9 | `ublicEncrypt({ key: publicKey, oaep*****` |
| panva/jose | test/jwt/encrypt.test.ts | keyword-value | 10 | 10 | `  secret: Uint******` |
| panva/jose | test/jwt/sign.test.ts | jwt | 24 | 100 | `    'eyJh****************` |
| panva/jose | test/jwt/sign.test.ts | jwt | 35 | 200 | `    'eyJh****************` |
| panva/jose | test/jwt/unsecured.test.ts | jwt | 19 | 56 | `  t.is(jwt, 'eyJh****************` |
| panva/jose | test/jwt/unsecured.test.ts | jwt | 39 | 57 | `nsecuredJWT.decode('eyJh****************` |
| panva/jose | test/util/decode_jwt.test.ts | jwt | 7 | 155 | `    'eyJh****************` |
| panva/jose | test-d/api.ts | keyword-value | 15 | 10 | `declare const secret: Uint******` |
| panva/jose | test-d/api.ts | keyword-value | 243 | 10 | `s<typeof compactVerified.key, Uint******` |
| panva/jose | test-d/api.ts | keyword-value | 244 | 10 | `typeof flattenedVerified.key, Uint******` |
| panva/jose | test-d/api.ts | keyword-value | 245 | 10 | `s<typeof generalVerified.key, Uint******` |
| panva/jose | test-d/api.ts | keyword-value | 246 | 10 | `quals<typeof jwtVerified.key, Uint******` |
| panva/jose | test-d/api.ts | keyword-value | 247 | 10 | `<typeof compactDecrypted.key, Uint******` |
| panva/jose | test-d/api.ts | keyword-value | 248 | 10 | `ypeof flattenedDecrypted.key, Uint******` |
| panva/jose | test-d/api.ts | keyword-value | 249 | 10 | `<typeof generalDecrypted.key, Uint******` |
| panva/jose | test-d/api.ts | keyword-value | 250 | 10 | `uals<typeof jwtDecrypted.key, Uint******` |
| motdotla/dotenv | README.md | private-key | 127 | 78 | `PRIVATE_KEY="----****************` |
| motdotla/dotenv | scripts/parse-perf.js | keyword-value | 21 | 45 | `TH_GOOGLE_CLIENT_ID=1234****************` |
