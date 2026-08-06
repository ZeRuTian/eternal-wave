# Troubleshooting

## "Nothing happening?"

If the camera runs for a while without decoding a single frame, a small toast appears above the preview asking exactly that. **Help** opens the tips; **Dismiss** snoozes it (it returns later if things are still dead — tapping a button doesn't make frames arrive).

The fixes are on the **sender**, which is the non-obvious part. In order:

1. On the sender, open Transfer settings and drop **bytes / frame to 1465**. The 2953-byte default is tuned for close-range phone-to-phone and is exactly what fails on an ordinary monitor at arm's length.
2. Still nothing? Drop the sender's **tx fps to 24**.
3. Fill this camera's view with the code, and prop the phone against something — autofocus hunting from hand tremor is the usual culprit.
4. Turn the sending screen's brightness all the way up.

## Camera problems

- **Permission denied** — tap the browser's permission prompt carefully; if you hit Block by accident, allow camera for the site and tap **Start camera** again (no reload needed).
- **"camera needs a secure context"** — the page is being served over plain http. Browsers remove the camera API on insecure origins; serve over https (the dev server already does, self-signed) or use [decimen.app](https://decimen.app/).
- **Standalone receiver file** — opening `decimen-receiver.html` from `file://` will not get a camera on iOS or Android. See [Install & offline](install-and-offline.md).

## Slow transfers

See the tuning table in [Sending](sending.md) — bytes/frame and tx fps are the two levers that matter.
