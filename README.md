# IG Profile Video Downloader

A Chrome/Edge extension (Manifest V3) that collects and downloads the videos
(posts + Reels) of an Instagram profile, using your own logged-in browser
session.

## How it works

Instead of reimplementing Instagram's private API (which needs specific headers
and changes often), the extension **intercepts the network responses Instagram
already fetches** while you scroll the profile. A script injected into the page
context (`content_main.js`) hooks `fetch`/`XMLHttpRequest`, looks for videos in
the JSON responses and passes them back to the extension.

A second script (`content_isolated.js`) scrolls the page automatically (the feed
and, if present, the Reels tab) to force more posts to load, and opens the posts
whose video has not been captured yet — the initial HTML only carries the first
~12 in full, the rest require opening each post individually.

The interface lives in a **side panel** (Chrome's Side Panel, the same pattern
extensions like MetaMask use) rather than a traditional popup, so it stays
pinned on screen instead of closing when it loses focus.

## Installation (developer mode)

1. Open `chrome://extensions`.
2. Enable "Developer mode" (top-right corner).
3. Click "Load unpacked" and select the `instagram-video-downloader` folder.

## Usage

1. Log in to Instagram normally in your browser.
2. Open the profile you want (`instagram.com/username`).
3. Click the extension icon — this opens the side panel, which stays open until
   you close it.
4. Click **"Scan profile"** and wait. The counter of videos found updates live.
5. To download, two options:
   - **"Download all (Downloads folder)"** — saves to
     `Downloads/instagram/<username>/<date>_<shortcode>.mp4`.
   - **"Choose folder..." + "Download all into that folder"** — lets you pick
     any folder on your computer (via the File System Access API) and writes
     the files straight there.
   - Each video in the list also has its own buttons: ↓ (green) downloads just
     that video, × (red) removes it from the list.

## Limits and important warnings

- **Fragility**: Instagram changes its response format often. If videos stop
  being found, the format has probably changed and the scanner (`extractVideos`
  in `content_main.js`) needs adjusting.
- **Stories** are not implemented (they expire quickly and use a different
  network flow); feed posts and Reels only.
- **Carousels** (posts with several videos/photos) are captured as long as
  Instagram includes the video data in the response.
- **Rate limiting**: scrolling very fast or downloading hundreds of videos at
  once can get the account throttled or flagged. The scripts already insert
  small delays; avoid running this constantly or across several accounts in a
  row.
- **Responsible use**: use it only for your own content, or for profiles you
  have permission to download from. Downloading and redistributing other
  people's videos without authorisation can infringe copyright and Instagram's
  Terms of Use.

## Structure

```
instagram-video-downloader/
├── manifest.json                 # extension config (MV3)
├── content_main.js               # fetch/XHR hook (MAIN world)
├── content_isolated.js           # auto-scroll + opens posts + message relay
├── background.js                 # per-tab state + downloads + side panel
├── sidepanel.html / sidepanel.js # extension UI (side panel)
```
