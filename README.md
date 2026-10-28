# Mini FSM voice page

One static page (index.html, voice.css, voice.js, voice-io.js). No build step, no secrets in it. Talk on the job card opens
it in its own Safari tab, because Safari will not give the microphone to a page inside Google's frame.

How it works: the card asks the server for a one time ticket for the visit (good 10 minutes, single use) and opens
`<VOICE_PAGE_URL>#t=<ticket>&e=<event id>&a=<public web app address>`. The page trades the ticket with the web app (a POST with a
plain text body, so the browser sends no CORS preflight) for a session, the card's fields and a short lived ElevenLabs token
(Deepgram when Setup says so). Every confirmed change is saved by the server as a field only save. The server side is
src/VoicePage.gs; `a=` must be the public deployment (the one in Setup, Reviews, REVIEW_APP_URL).

Hosting: any static host. Put these four files at the root of the site and set the Script Property VOICE_PAGE_URL to the page's
address (https, with the trailing slash, for example https://USER.github.io/mini-fsm-voice/). Empty means Talk says "Voice page not
set up yet". voice-io.js is a copy of the script in src/VoiceIO.html; copy it again when that file changes (the tests check it).

Check the connection from the host: open `<page address>#check&a=<public web app address>`. It says Connected when the browser lets
the page read the web app's answer.
