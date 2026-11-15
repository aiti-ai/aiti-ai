# Third-party notices

This project is an independent implementation for the pi ecosystem. Where rule shapes,
detection methodology or testing harness ideas follow prior MIT-licensed work, that
attribution is made below together with the full license text required by the MIT license.

The following are referenced as **sources of publicly documented token shapes, rule ideas and
test methodology** — no source code from these projects is vendored here:

| Project | What we took | License |
|---|---|---|
| [karanb192/claude-code-redact](https://github.com/karanb192/claude-code-redact) | Secret rule shapes (prefix tokens, JWT/PEM/DB-URL/auth-header/generic-assignment), entropy & false-positive guard ideas, salted-placeholder format idea, fp-corpus measurement methodology | MIT © 2026 Karan Bansal |
| [dinhkarate/keyshroud](https://github.com/dinhkarate/keyshroud) | Multi-form matching idea (`redactForms`: JSON leaves / long base64 runs of multi-part values), minimum-length noise guard | MIT © 2026 Daniel / EONSR |
| [gitleaks/gitleaks](https://github.com/gitleaks/gitleaks) | Public token-format reference for several prefix rules | MIT © 2019 Zachary Rice |

`src/detect.ts` header carries the same attribution.

The fp-corpus harness (`tools/fp-corpus.mjs`) shallow-fetches 11 pinned public repositories
and **scans** them locally; those repositories are not redistributed and remain under their
own licenses.

## Trademarks

Anthropic, Claude, OpenAI, GitHub, GitLab, Slack, Stripe, SendGrid, Twilio, Google, Azure,
Hugging Face, npm, PyPI and AWS are trademarks of their respective owners. They appear in
rule ids/labels and documentation **solely to describe the credential formats this tool
detects** (nominative fair use). This project is not affiliated with, endorsed by, or
sponsored by any of them, and none of these marks are used in this package's name.

## MIT License (full text, applied to the referenced projects)

```
MIT License

Copyright (c) 2026 Karan Bansal
Copyright (c) 2026 Daniel / EONSR
Copyright (c) 2019 Zachary Rice

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
