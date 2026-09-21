# Toreca Vault V2 Apps Script automation

This directory is the canonical source for the **separate** V2 automation Apps Script project.

## Deployment rule

Do not build the Apps Script project by repeatedly pasting small code fragments on a phone.

1. Finish and test the complete source in GitHub first.
2. Deploy the complete `Automation.gs` as one unit to a separate Apps Script project.
3. Configure only `TV_V2_DATA_FILE_ID` in Script Properties.
4. Run `previewTorecaVaultV2Automation()` first. It is read-only.
5. Confirm the returned schema/revision/counts against REAL V2.
6. Keep lottery and market production writers disabled until their acceptance tests pass.
7. Only then install V2 triggers.

## Safety boundaries

- Never point this automation at the V1 file.
- Do not combine this automation project with the V2 persistence API project.
- Do not install triggers while the lottery parser or market fetcher is disabled.
- Every future write must use revision + mutationId checks and post-save reread verification.
- On verification failure, restore and verify the original bytes.

The current `Automation.gs` intentionally keeps Gmail parsing and market fetching disabled.


## Phone deployment acceptance

The phone-side acceptance path is intentionally one-shot:

1. Paste/replace the complete tested `Automation.gs` once.
2. Save once.
3. Run `acceptTorecaVaultV2Deployment()` once.
4. The combined acceptance checks REAL V2 read-only access plus market fail-closed normalization and must report `readOnly: true`, `accepted: true`, `productionReady: false`, and no V2 trigger handlers.

Do not paste helper functions in separate fragments. If the complete source cannot be saved reliably, stop rather than assembling a partial production script.

Production trigger installation is deliberately impossible in the current source because both writer readiness functions return `false`.

## Market read-only acceptance

After the one-shot source deployment, `acceptTorecaVaultV2MarketReadOnly()` verifies market normalization and fail-closed behavior without fetching live prices or writing REAL V2. It must return `readOnly: true`, `accepted: true`, and `productionReady: false` before any market writer work proceeds.

`acceptTorecaVaultV2Deployment()` is the preferred phone-side acceptance entry point. It combines the read-only data check and market normalization check into one run; it still cannot enable production writers or install triggers.
