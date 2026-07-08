# UI Rater — Task Tracker Chrome Extension

Chrome extension that tracks user interactions and records video while participants complete tasks on real production websites.

## Requirements

- Google Chrome (version 116 or later)
- Node.js (version 18 or later)
- npm (included with Node.js)
- Git

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/rvempati24/ui-rater-extension.git
cd ui-rater-extension
```

### 2. Start the local server

```bash
cd server
npm install
npm run dev
```

The server runs at `http://localhost:3000` and stores all data locally in `server/data/results.json`. No data is sent to any remote server.

### 3. Install the Chrome extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `ui-rater-extension` folder (the root of the repo, not the `server` subfolder)
4. Pin the extension icon in the toolbar for easy access

## Completing the Study

1. Click the extension icon in the Chrome toolbar
2. Enter your assigned **Participant ID** (e.g., P001)
3. Set the server URL to `http://localhost:3000`
4. Click **Load Tasks**

For each task:

1. Read the task prompt displayed in the popup
2. Click **Begin Task** — Chrome navigates to the target website and starts recording
3. Complete the task as described (or get as far as you can)
4. Click the extension icon again and click **Done** to submit
5. To skip a task, click **Skip** instead

Repeat until all 10 tasks are complete.

## Tasks

| # | Website | Task |
|---|---------|------|
| 1 | United Airlines | Search for a one-way flight from NYC to LA on Jan 15 for 1 adult in economy |
| 2 | Booking.com | Search for hotels in Paris for 2 adults, Jan 10–15 |
| 3 | Amazon | Search for wireless noise-canceling headphones under $100 with 4+ star rating |
| 4 | Target | Search for a queen-size bed frame under $300, filter by 4+ star rating |
| 5 | OpenTable | Find Italian restaurants in SF for 4 people this Saturday at 7 PM |
| 6 | AllTrails | Find best-rated moderate difficulty hiking trails near Denver, CO |
| 7 | Zillow | Search for houses in Austin, TX with 3+ bedrooms under $500K |
| 8 | Indeed | Search for remote software engineer jobs with salary above $120K |
| 9 | ESPN | Find the current NBA standings for the Western Conference |
| 10 | Coursera | Search for free machine learning courses from Stanford University |

Tasks are sourced from the [Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web) benchmark. Participants interact with actual production websites. The extension does not modify or interfere with any website's functionality.

## Returning Your Data

When all tasks are complete, send the `data/` folder to the research team. It contains:

1. **Interaction data**: `data/results.json`
2. **Task recordings**: `data/recordings/` (one `.webm` video per task, e.g., `P001_task1.webm`)

## What Is Collected

### Interaction Events

| Event | Data Recorded |
|-------|---------------|
| Click | Timestamp, coordinates, element tag/class, visible text (first 80 chars), link URL |
| Right-click | Timestamp, coordinates, element tag |
| Scroll | Timestamp, scroll position — throttled to 200ms |
| Mouse movement | Timestamp, coordinates — throttled to 100ms |
| Keyboard input | Timestamp, key pressed, modifier keys (Ctrl/Shift/Alt/Cmd) |
| Text input | Timestamp, field value (first 200 chars), input type |
| Form focus | Timestamp, element tag, input type |
| Form submission | Timestamp, form action URL, method |
| Copy/Paste | Timestamp only — clipboard contents are NOT recorded |
| Window resize | Timestamp, new dimensions |
| Page navigation | Timestamp, destination URL, navigation method |
| Page load | Timestamp, URL, page title |

All timestamps are relative to task start (timestamp 0 = clicked "Begin Task").

### Video Recording

Each task is recorded as a `.webm` video file capturing the browser tab contents. Videos are saved automatically to `data/recordings/` when a task is completed (e.g., `P001_task1.webm`). Video is recorded at 1.5 Mbps.

### What Is NOT Collected

- Clipboard contents (only the act of copying/pasting is logged)
- Passwords or authentication credentials
- Cookies, session tokens, or browser storage
- Browser history outside of study tasks
- Data from other tabs or windows
- Any personally identifiable information beyond the assigned Participant ID

## Data Format

The `results.json` file contains one entry per participant with an array of 10 trials:

```json
{
  "P001": {
    "trials": [
      {
        "index": 1,
        "slug": "united",
        "task_prompt": "Search for a one-way flight from New York to Los Angeles on January 15th for 1 adult in economy class",
        "completed": true,
        "timestamp": "2026-07-03T14:32:01.000Z",
        "view_start": "2026-07-03T14:30:15.000Z",
        "duration_ms": 106000,
        "interactions": [
          {
            "kind": "click",
            "ts": 5300,
            "url": "https://www.united.com/",
            "tag": "button.submit-btn",
            "text": "Search flights",
            "x": 340,
            "y": 512
          }
        ]
      }
    ]
  }
}
```

## Architecture

```
ui-rater-extension/
├── manifest.json          Manifest V3 config
├── content.js             Injected into each page, captures DOM events
│                          Persists tracking state in chrome.storage.local
│                          Flushes events to background worker every 10s
├── background.js          Accumulates interactions across page navigations
│                          Manages tab capture and offscreen recording
│                          Sends data to local server on task completion
│                          Downloads recorded video via chrome.downloads
├── offscreen.html/js      Records tab MediaStream using MediaRecorder API
│                          Produces WebM video blobs
├── popup.html/js          Participant-facing UI for task management
│
└── server/                Local data server (Next.js)
    └── app/api/               REST endpoints for receiving data
        ├── tasks/             GET — returns task list for participant
        ├── complete-task/     POST — saves completed task data
        ├── partial-save/      POST — periodic saves during task
        └── upload-recording/  POST — receives video recordings

└── data/                      All study output (send this folder back)
    ├── results.json           Interaction traces
    ├── recordings/            Task videos, e.g. P001_task1.webm
    ├── trials-config.json     Task definitions
    └── participants.json      Valid participant IDs
```

All processing happens locally. The only network traffic is between the participant's browser and the real websites they visit during tasks.

## Estimated Time

10 tasks, approximately 2–5 minutes each. Total session: 25–50 minutes.
