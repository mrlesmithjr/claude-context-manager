# Security Policy

## Supported versions

Security fixes are applied to the latest release on the `main` branch only. Older patch versions are not backported.

| Version | Supported |
|---------|-----------|
| Latest (`main`) | Yes |
| Earlier releases | No |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.** Public disclosure before a fix is available puts all users at risk.

Report vulnerabilities privately by email:

**mrlesmithjr@gmail.com**

Include in your report:
- Plugin version (from `package.json` or `/plugin list` in Claude Code)
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (sanitized of any real credentials or personal data)
- Your assessment of severity

## Response timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgement | Within 48 hours |
| Severity assessment | Within 5 business days |
| Patch for critical issues | Within 14 days of confirmation |
| Patch for moderate issues | Within 30 days of confirmation |

You will be credited in the release notes unless you prefer to remain anonymous.

## Privacy context

This plugin captures Claude Code tool interactions and stores them in a local SQLite database. Key privacy guarantees built into the codebase:

- Prompt content is never logged, even at debug level.
- `old_string`, `new_string`, and `content` fields from Edit/Write tool results are stripped before storage.
- Sensitive content wrapped in `<private>` tags is redacted before any storage occurs.
- The bearer token required for remote mode is never logged.

Vulnerabilities that would allow unintended disclosure of prompt content, personal data, or bearer tokens are treated as critical severity.
