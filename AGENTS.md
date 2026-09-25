# Toreca Vault maintenance

For every code or deployment change, append a dated entry to `docs/HANDOVER.md` in the same commit. State what changed, why, how it was tested, production status, and remaining limits. Update the status after deployment in a follow-up commit when the outcome becomes known.

Keep tokens, account credentials, script property values, and private Drive file identifiers out of the repository and handover. A handover file records the workflow; it never grants remote access. Use the connected GitHub account and existing deployment workflow when available, and verify permissions in each new session.

The user works primarily on a phone. Report progress in chat. Show the handover file to the user when they ask for it; routine replies can link the relevant PR or deployment result instead.
