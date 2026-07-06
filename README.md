# UI Rater — Task Tracker Chrome Extension

Chrome extension that tracks user interactions and records video while participants complete tasks on real production websites.

## Requirements

- Google Chrome (version 116 or later)
- Node.js (version 18 or later)
- npm (included with Node.js)
- Git

## Setup

### 1. Clone and start the local server

```bash
git clone https://github.com/rvempati24/UI-rater.git
cd UI-rater
npm install
npm run dev
```

The server runs at `http://localhost:3000` and stores all data locally in `data/results.json`. No data is sent to any remote server.

### 2. Install the Chrome extension

```bash
git clone https://github.com/rvempati24/ui-rater-extension.git
```

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `ui-rater-extension` folder
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

Repeat until all 9 tasks are complete.

## Tasks

| # | Website | Task |
|---|---------|------|
| 1 | DoorDash | Find a pizza restaurant and add a medium pepperoni pizza to cart |
| 2 | United Airlines | Search for a one-way flight from SFO to Chicago on Dec 18 |
| 3 | Airbnb | Search for stays in Paris, Jul 1–5, 2 adults, filter under $150/night |
| 4 | Gmail | Compose an email to test@example.com with subject "Meeting Notes", then discard |
| 5 | OpenTable | Search for a restaurant in SF for 4 on a Friday evening, view menu |
| 6 | LinkedIn | Search for Software Engineer jobs in SF and save one |
| 7 | Uber | Get a price estimate from SFO to downtown SF |
| 8 | Upwork | Search for a freelance React developer and view their profile |
| 9 | Zillow | Search for homes in SF under $750K with 2+ bedrooms, view a listing |

Participants interact with the actual production websites. The extension does not modify or interfere with any website's functionality.

## Returning Your Data

When all tasks are complete, send the following files to the research team:

1. **Interaction data**: `UI-rater/data/results.json`
2. **Task recordings**: `~/Downloads/ui-rater-recordings/` (one `.webm` video per task)

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

Each task is recorded as a `.webm` video file capturing the browser tab contents. Videos are saved automatically to the `Downloads/ui-rater-recordings/` folder when a task is completed. Video is recorded at 1.5 Mbps.

### What Is NOT Collected

- Clipboard contents (only the act of copying/pasting is logged)
- Passwords or authentication credentials
- Cookies, session tokens, or browser storage
- Browser history outside of study tasks
- Data from other tabs or windows
- Any personally identifiable information beyond the assigned Participant ID

## Data Format

The `results.json` file contains one entry per participant with an array of 9 trials:

```json
{
  "P001": {
    "trials": [
      {
        "index": 1,
        "slug": "doordash",
        "task_prompt": "Find a pizza restaurant near you and add a medium pepperoni pizza to your cart",
        "completed": true,
        "timestamp": "2026-07-03T14:32:01.000Z",
        "view_start": "2026-07-03T14:30:15.000Z",
        "duration_ms": 106000,
        "interactions": [
          {
            "kind": "click",
            "ts": 5300,
            "url": "https://www.doordash.com/",
            "tag": "button.submit-btn",
            "text": "Add to cart",
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
Chrome Extension
├── content.js          Injected into each page, captures DOM events
│                       Persists tracking state in chrome.storage.local
│                       Flushes events to background worker every 10s
│
├── background.js       Accumulates interactions across page navigations
│                       Manages tab capture and offscreen recording
│                       Sends data to local server on task completion
│                       Downloads recorded video via chrome.downloads
│
├── offscreen.html/js   Records tab MediaStream using MediaRecorder API
│                       Produces WebM video blobs
│
├── popup.html/js       Participant-facing UI for loading tasks,
│                       starting/stopping tracking, and navigation
│
└── manifest.json       Manifest V3, permissions: storage, tabs,
                        tabCapture, offscreen, downloads, scripting

Local Server (localhost:3000)
└── POST /api/complete-task    Receives interaction data
    POST /api/partial-save     Periodic saves during task (every 10s)
    GET  /api/tasks            Returns task list for participant
    Writes to data/results.json on disk
```

All processing happens locally. The only network traffic is between the participant's browser and the real websites they visit during tasks.

## Estimated Time

9 tasks, approximately 2–5 minutes each. Total session: 20–45 minutes.
