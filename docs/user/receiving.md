# Receiving

Open `/receive/`, tap **Start camera**, point it at the sender's code. There is no pairing: the receiver locks onto any Decimen stream mid-flight, works out on its own whether a file or text is arriving, and restarts cleanly if the sender does.

Fill the camera view with the code and prop the phone against something — autofocus hunting from hand tremor is the #1 throughput killer. On cameras that support it (Android, typically) continuous autofocus is enabled automatically.

Progress counts **frames collected**, not blocks solved — fountain decoding back-loads its solve cascade, so the bar is estimated from frame rate and only verified completion reaches 100%.

## When it lands

- The file is verified against its SHA-256 before anything is offered.
- Images, video, and audio preview inline — video plays in the page (never autoplays), other files just get the **Save** link.
- **Receive another file** reloads into a fresh receiver.
- **Clear Decimen cache** scrubs the received bytes from browser storage — see [Privacy](privacy.md).
- Text snippets appear with a **Copy** button and exist only until the tab closes.

**Live diagnostics** (capture/decode fps, goodput, frames, K) is collapsible during the transfer and becomes the **Transfer summary** when it ends.

## Receive settings

Applied live while the camera runs; a device that refuses a live reconfigure (iOS, sometimes) keeps the current stream and says so. Frame rates the camera reports it cannot reach are grayed out.

| setting | default | notes |
|---|---|---|
| capture width | 1280 | 1920 costs decode time; 960 helps weak CPUs |
| capture fps | 60 | iOS delivers 30 unless the exact rate is demanded — the app handles this |
| decode workers | 2 | one WASM decoder per worker; busy workers drop frames, which the fountain absorbs |
