# ClearCare

A responsive, accessible, synthetic-data demo that helps patients and caregivers organize discharge instructions.

## Requirements

- Node.js 18 or newer
- No npm packages, API keys, or external services required for text-based PDF extraction

## Run

```sh
npm start
```

Open `http://localhost:4174`. To use another local port, set `PORT` before starting (for example, PowerShell: `$env:PORT=5000; npm start`). The server binds to `127.0.0.1` and serves the app locally.

## Use the demo

Select **Add discharge papers** and upload a text-based PDF from `discharge_pdf/`, or choose a synthetic scenario from the picker. The PDF is read in the browser, its embedded text is extracted, and deterministic rules build a schema-validated care plan with source evidence. Uploaded bytes are not sent to the server or written to disk. The supported PDF parser is intentionally small and tested against the included synthetic PDFs. It is not a general-purpose PDF/OCR engine.

Image files and scanned PDFs without embedded text are not OCRed. They produce an incomplete result rather than guessed instructions. Password-protected, malformed, or unsupported compressed PDFs may also be rejected. The extractor recognizes a limited set of medication names and common follow-up date/time patterns; always compare results to the source. The server only serves the app files; document parsing does not depend on a separate API request.

## Manual PDF test files

Six fictional, clearly labeled PDFs are in `discharge_pdf/`:

- `01_everyday_recovery.pdf` — ordinary recovery instructions and a complete follow-up.
- `02_ambiguous_dose.pdf` — metoprolol dose with no unit.
- `03_conflicting_warfarin.pdf` — two conflicting warfarin doses and an incomplete follow-up.
- `04_missing_units_insulin.pdf` — missing units for two medicines, including high-risk insulin.
- `05_high_risk_apixaban.pdf` — high-risk anticoagulant review and a missing appointment location.
- `06_unreadable_scan.pdf` — intentionally illegible values and an incomplete appointment.

Every file is marked synthetic and not for clinical use. The included text-based PDFs can now be uploaded and parsed locally. `06_unreadable_scan.pdf` contains illegible sample values, and tests verify these remain incomplete instead of being filled in.

## Gemini explanations and care questions

Each medication and care instruction in **My care plan** has an **Explain simply** button. No request is made at page load. Clicking one button sends only that instruction and the selected language to the local backend; it never sends the PDF, full plan, patient identity, or conversation history.

The backend calls Google's Gemini `generateContent` API using the stable `gemini-3.8-flash` model by default. The server loads the project-root `.env` file on startup on Node 18 and newer; shell environment variables take precedence. It reads `GEMINI_API_KEY` on the server only; an optional `GEMINI_MODEL` environment variable can select another model available to your key. Never put the key in frontend files or commit it. For PowerShell, create a local `.env` file from the safe template if you do not already have one, then edit it:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `GEMINI_API_KEY=your-gemini-api-key` in that file, save it, and restart `npm start`. Or set it in the current terminal before starting:

```powershell
$env:GEMINI_API_KEY = "your-gemini-api-key"
npm start
```

Get a key from [Google AI Studio](https://aistudio.google.com/app/apikey). The Windows desktop launcher also reads the same project-root `.env` file. The `.env` file is ignored by git.

At startup, the terminal reports whether `GEMINI_API_KEY` is configured (the value is never printed). The app uses Gemini for **Explain simply**, grounded document questions, the Care Agent, and optional care-plan translation. These routes make requests only after a user action. The Gemini key is sent in the server-to-Google `x-goog-api-key` header and is never returned to the browser or written to logs. Automated test fixtures use mocked Gemini responses and do not make live API requests.

For **Explain simply**, the selected instruction is the only document text sent for that request; the PDF, full plan, patient identity, and conversation history are not sent. A fixed prompt asks for at most two short sentences, exact meaning preservation, no new medical advice, no dose/schedule/treatment changes, and explicit clarification when ambiguous. Gemini responses are schema-checked and independently checked against the source before display. Successful results are cached by instruction and language; simultaneous duplicate requests share one provider call. Error responses are not cached. A retry happens only when a user chooses to retry.

The explanation is labeled separately from the original instruction and includes a care-team reminder. It is not clinician approval or a replacement for the original instruction. Tests mock Gemini responses. To demonstrate one real inference, configure `GEMINI_API_KEY`, restart the server, open a synthetic care plan, and click **Explain simply** beside one instruction. Gemini API quotas and billing depend on your Google AI account and model access.

## Safety behavior

- High-risk drugs and ambiguous doses are visibly sent to review. There is no control to approve medication instructions in the demo.
- Conflicting and missing-unit instructions remain unresolved and retain their original source text.
- Calendar export includes only appointments marked confirmed with a date, time, and complete location. Review-needed or incomplete visits cannot be exported.
- The extracted source text is kept separate from the plain-language summary and escaped before rendering.
- The care-plan checklist has one-tap completion that is shared with review follow-ups. Checking a task never clears the medical review status. Medication pickup reminders have no invented due date; only confirmed appointments with complete details export to `.ics`.
- Use synthetic data only. Avoid uploading real medical records.

This is a hackathon demo, not a medical device, clinical decision support system, or replacement for a clinician. AI extraction, OCR, automatic whole-site translation, direct calendar integration, real authentication, and durable patient-data storage are not implemented. The demo sign-in is local-only. Local deterministic extraction is limited and must be checked against the PDF source.

## Hackathon presentation assets

- Cover image: `CLEARCARE_AMD_ACT_III_SUBMISSION/cover.png` (1920 × 1080).
- Editable 9-slide deck: `CLEARCARE_AMD_ACT_III_SUBMISSION/ClearCare_Hackathon_Presentation.pptx`.
- Narrated 1080p video: `CLEARCARE_AMD_ACT_III_SUBMISSION/videos/ClearCare_Hackathon_Presentation.mp4`.
- Captions: `CLEARCARE_AMD_ACT_III_SUBMISSION/videos/ClearCare_Hackathon_Presentation.srt`.

The existing deck and video are archived AMD-hackathon materials and still describe the former AMD integration; they have not been regenerated for the Gemini provider change. To regenerate them on Windows with Python Pillow/python-pptx, PowerPoint, and a Windows speech voice installed:

```powershell
python CLEARCARE_DEMO_AUTOMATION/make-presentation.py
powershell -ExecutionPolicy Bypass -File CLEARCARE_DEMO_AUTOMATION/export-presentation-video.ps1
```

## Checks

```sh
npm test
node --check server.js
node --check public/app.js
```

The tests cover PDF text extraction from the included synthetic files, structured field extraction, source evidence, ambiguous/conflicting/missing-unit detection, high-risk escalation, unreadable content handling, schema checks, and calendar eligibility. These are fixture-based checks on the included files, including the browser-side upload reader; they do not measure general PDF accuracy, OCR, or clinical safety.

- The app language selector translates the main navigation and key dashboard, care plan, review, calendar, settings, and upload interface text into English, Spanish, or Hindi. The chosen language is remembered for the Jordan demo profile in this browser. Original document text and evidence remain unchanged.
