// Downloads and installs the herdr client binary into the sandbox image.
// Run inside the image during docker build (see Dockerfile).
// Version + sha256 pinned from https://herdr.dev/latest.json (v0.9.5).
const fs = require('fs');
const crypto = require('crypto');

const URL = 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64';
const SHA = '14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d';

(async () => {
  const r = await fetch(URL);
  if (!r.ok) throw new Error('herdr download: HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== SHA) throw new Error('herdr sha256 mismatch: ' + sha);
  fs.writeFileSync('/usr/local/bin/herdr', buf);
  fs.chmodSync('/usr/local/bin/herdr', 0o755);
  console.log('herdr 0.9.5 installed, sha256 ok');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
