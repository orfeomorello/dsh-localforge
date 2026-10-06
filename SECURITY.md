# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting: open the **Security** tab of this
repository and select **Report a vulnerability**. That opens a private advisory
that only the maintainers can see.

A useful report includes:

- the affected version, commit, or release;
- what the issue is and what an attacker gains from it;
- reproduction steps, ideally minimal;
- a suggested fix, if you have one.

## Scope notes

LocalForge is an adapter between DeepSeek Harness and a local LLM server, so two
behaviours are worth naming when assessing a report:

- the adapter resolves `apiKeyEnv` through the harness credentials service and
  sends the resolved value to the configured `baseURL` as a bearer token;
- every log line goes through `pino` with redaction applied to the
  `authorization`, `x-api-key`, `apiKey` and `apiKeyEnv` paths.

A report showing either guarantee failing is in scope. A report that requires an
already-compromised host, or a malicious LLM server that the operator pointed
the plugin at on purpose, is generally out of scope — though we would still like
to hear about it.

## Disclosure

We aim to acknowledge reports promptly, and to ship a fix or a documented
mitigation as soon as practical. Credit is given in the release notes unless you
prefer to stay anonymous.
