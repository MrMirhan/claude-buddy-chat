# Third-party notices

buddy-chat includes the code below in `hooks/vendor/`. Each part keeps its own license. The MIT license in `LICENSE` covers the rest of this repository.

## TweetNaCl.js

- File: `hooks/vendor/nacl.js` (from `nacl-fast.js`, version 1.0.3, wrapped as an ES module)
- Source: https://github.com/dchest/tweetnacl-js
- License: The Unlicense (public domain). Full text: `hooks/vendor/LICENSE-tweetnacl`
- Authors: Dmitry Chestnykh, Devi Mandiri, and the TweetNaCl authors (Daniel J. Bernstein, Bernard van Gastel, Wesley Janssen, Tanja Lange, Peter Schwabe, Sjaak Smetsers)
- Changes: the UMD wrapper became an ES module export, and the random number source reads `globalThis.crypto.getRandomValues`.

## noble-post-quantum and noble-hashes

- File: `hooks/vendor/mlkem.js` (ML-KEM-768 only, bundled into one file with esbuild)
- Sources: https://github.com/paulmillr/noble-post-quantum (version 0.7.1) and https://github.com/paulmillr/noble-hashes (version 2.4.0)
- License: MIT. Copyright (c) 2024 Paul Miller (https://paulmillr.com). Full text: `hooks/vendor/LICENSE-noble`
- Changes: none to the code; only the parts that ML-KEM-768 needs are bundled.
