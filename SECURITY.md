# Security

TaskSparkle's promise is private boards. Each person sees only their own boards. An agent key reaches only its owner's boards. A flaw in that promise is a security problem. This page is the route for reporting one.

## What counts

Anything that lets a caller reach boards, cards or comments that are not theirs. Examples:

- A sign-in that can be bypassed or forged
- An agent key reaching beyond its owner
- One person's data showing in another person's answers
- A stored value that breaks out of its place when the app renders it. A card, a comment or a key name can hold such a value.

Ordinary bugs that expose nothing belong in a public issue.

## How to report

Use GitHub's private vulnerability reporting: the **Report a vulnerability** button under this repository's **Security** tab. The report goes to the maintainer only, and the conversation stays private while the problem is fixed.

Please include the steps that make the problem happen, which way the copy was running (Cloudflare hosted or self-hosted) and the release version or build stamp.

## What to expect

One maintainer looks after this project on a best-effort basis. A report gets an acknowledgement within a few days. A confirmed problem is fixed and shipped in a release. The release notes say a security fix landed. They do not describe the hole before people have had a fair chance to update. Credit in the release notes is yours if you want it.

## Supported versions

The latest release is the supported one. Self-hosters: run the newest release, because security fixes land there and are not backported.
