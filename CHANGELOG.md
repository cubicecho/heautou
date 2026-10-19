# [1.13.0](https://github.com/cubicecho/heautou/compare/v1.12.0...v1.13.0) (2026-10-19)


### Features

* build forward auth proxy snippets on the Protected sites page ([e27801f](https://github.com/cubicecho/heautou/commit/e27801f42288f661e536f0f4d51f315822f75bd3))
* client presets for common homelab apps and the cubicecho apps ([87f5cba](https://github.com/cubicecho/heautou/commit/87f5cba9a179283cce4390798106417671297acc)), closes [#4](https://github.com/cubicecho/heautou/issues/4)

# [1.12.0](https://github.com/cubicecho/heautou/compare/v1.11.0...v1.12.0) (2026-10-19)


### Bug Fixes

* cap an API's access tokens at the API maximum when it sets no lifetime ([8d15bd7](https://github.com/cubicecho/heautou/commit/8d15bd740b7093913e4a457e1353c00fd3f3b9a2))


### Features

* access tokens for a named API with resource indicators ([80a9cfa](https://github.com/cubicecho/heautou/commit/80a9cfa093ac5edd48f21959389063c379369148)), closes [#12](https://github.com/cubicecho/heautou/issues/12)
* forward auth for sites behind a reverse proxy ([353172c](https://github.com/cubicecho/heautou/commit/353172ca2dddbe48204ff02d773d947ebd52b868)), closes [#10](https://github.com/cubicecho/heautou/issues/10)
* profile pictures, stored in S3-compatible storage ([902ee6c](https://github.com/cubicecho/heautou/commit/902ee6ceb50c5f208c7b1be55161c5979b559141)), closes [#14](https://github.com/cubicecho/heautou/issues/14)
* send invite and reset links, a forgot-password link and notices by email ([8a90cb5](https://github.com/cubicecho/heautou/commit/8a90cb5cce421cced38c37f755c589f7216c0724)), closes [#3](https://github.com/cubicecho/heautou/issues/3)

# [1.11.0](https://github.com/cubicecho/heautou/compare/v1.10.0...v1.11.0) (2026-10-18)


### Features

* back up and restore the data from Settings ([278a805](https://github.com/cubicecho/heautou/commit/278a8054196e6c4affaec07374d26295cf48db84)), closes [#15](https://github.com/cubicecho/heautou/issues/15)
* sign in through upstream providers such as Google and GitHub ([895cb0e](https://github.com/cubicecho/heautou/commit/895cb0eb73772f56ae2e19cb50fdf8fa8c260a4e)), closes [#17](https://github.com/cubicecho/heautou/issues/17)

# [1.10.0](https://github.com/cubicecho/heautou/compare/v1.9.0...v1.10.0) (2026-10-18)


### Features

* check new passwords for strength and known breaches ([64678aa](https://github.com/cubicecho/heautou/commit/64678aa1595ffef169782efae1e5acfe2c1f8ed6))
* let each client set its own token lifetimes ([ef27878](https://github.com/cubicecho/heautou/commit/ef27878f0a6db00536ff6ac768d84e1404fe148f))
* tell apps when their users sign out (back-channel logout) ([bfdb117](https://github.com/cubicecho/heautou/commit/bfdb117408eaeae1cac3cf5ffbde18a22f232447))
* two-factor sign-in with authenticator apps and passkeys ([98905d7](https://github.com/cubicecho/heautou/commit/98905d7f391f84562daf57a6410287742e4d170b)), closes [#2](https://github.com/cubicecho/heautou/issues/2)

# [1.9.0](https://github.com/cubicecho/heautou/compare/v1.8.0...v1.9.0) (2026-10-17)


### Features

* live activity and app sign-ins in the audit log ([88cd92e](https://github.com/cubicecho/heautou/commit/88cd92e52d42e392bf54895f94676bc689e9a6d4))

# [1.8.0](https://github.com/cubicecho/heautou/compare/v1.7.0...v1.8.0) (2026-10-17)


### Features

* add an audit log ([925696b](https://github.com/cubicecho/heautou/commit/925696b9430549a895690bc86b3d1465cf734702))

# [1.7.0](https://github.com/cubicecho/heautou/compare/v1.6.0...v1.7.0) (2026-10-17)


### Features

* require https redirect URIs unless allowed ([59381ca](https://github.com/cubicecho/heautou/commit/59381cad994ef86c4f6c72ef9d8d18f3eded613f))

# [1.6.0](https://github.com/cubicecho/heautou/compare/v1.5.0...v1.6.0) (2026-10-17)


### Features

* encrypt client secrets and signing keys at rest ([10bb226](https://github.com/cubicecho/heautou/commit/10bb226e101e575f04ee3e3df36600ba629d64b2))

# [1.5.0](https://github.com/cubicecho/heautou/compare/v1.4.1...v1.5.0) (2026-10-17)


### Features

* pair apps with a setup URL through dynamic client registration ([1b6469f](https://github.com/cubicecho/heautou/commit/1b6469fe1f7009e04c5297bdb720fa1b21b6b04a))

## [1.4.1](https://github.com/cubicecho/heautou/compare/v1.4.0...v1.4.1) (2026-10-17)


### Bug Fixes

* name the admin client by the brand in session lists ([7f11424](https://github.com/cubicecho/heautou/commit/7f11424618aadf35d197d2d25e3614197b1d96a4))

# [1.4.0](https://github.com/cubicecho/heautou/compare/v1.3.0...v1.4.0) (2026-10-16)


### Features

* add groups, invites, account page, sessions, key rotation and branding ([bb421b0](https://github.com/cubicecho/heautou/commit/bb421b06263ede2928a3762c9e19e60149b0a97a))

# [1.3.0](https://github.com/cubicecho/heautou/compare/v1.2.0...v1.3.0) (2026-10-16)


### Features

* let the first admin be made without a token for 10 minutes after boot ([1a6d79a](https://github.com/cubicecho/heautou/commit/1a6d79a68ca1812a1632e6b1aee369e8f9711e79))

# [1.2.0](https://github.com/cubicecho/heautou/compare/v1.1.0...v1.2.0) (2026-10-16)


### Features

* require an admin sign-in and harden the server for self-hosting ([efc4623](https://github.com/cubicecho/heautou/commit/efc46233651b340160e441987bda043b13a0affc))

# [1.1.0](https://github.com/cubicecho/heautou/compare/v1.0.0...v1.1.0) (2026-10-16)


### Features

* draw the sign-out, signed-out and error pages in the web app ([c9da1c8](https://github.com/cubicecho/heautou/commit/c9da1c83f5f7c0b5d60bd4f4e3d0c8f26cffae19))

# 1.0.0 (2026-10-16)


### Features

* minimal flat-file OIDC provider with a cubeui admin UI ([7dff678](https://github.com/cubicecho/heautou/commit/7dff6783202d0b7cfe45e4ada7bd18750bc8ad20))
