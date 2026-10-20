import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const artifactModule = 'C:/Users/Swathi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';
const { FileBlob, PresentationFile } = await import(pathToFileURL(artifactModule).href);
const source = 'C:/Users/Swathi/Downloads/Copy of Agentathon-Template.pptx';
const outDir = path.resolve('CLEARCARE_AMD_ACT_III_SUBMISSION');
const buildDir = path.resolve('.clearcare-pptx-build');
const presentation = await PresentationFile.importPptx(await FileBlob.load(source));

function replace(id, before, after) {
  const shape = presentation.resolve(id);
  if (!shape?.text?.toString().includes(before)) throw new Error(`Expected source copy not found in ${id}: ${before.slice(0, 70)}`);
  shape.text.replace(before, after);
}
function title(id, before, after) { replace(id, before, after); }

// Slide 2: concise project/team introduction. Team details are carried over from the supplied deck.
title('sh/9w76xob6', 'Agentathon 2026', 'ClearCare');
replace('sh/7up4vet0', 'Healthcare', 'Health and Wellbeing');
replace('sh/gjyx87y5', 'COLLEGE(S)  (list every college in the team)', 'COLLEGE');
replace('sh/2lgfahgb', 'One line, max 20 words. A small role is fin.', 'Retrieves relevant care evidence, calls AMD only on user action, verifies the response, and routes uncertainty to human review.');
replace('sh/hk7y1czq', 'One line, max 20 words. Say what it does, not how.', 'Turns discharge instructions into a source-linked, multilingual care plan with review flags and calendar-ready follow-up.');
replace('sh/uxwf6xgz', 'Jawwaad Sheriff', 'Jawwaad Sheriff');
replace('sh/fi5gz2hk', 'MEMBER 3', 'TEAM SIZE');
replace('sh/fi5gz2hk', 'Adishree Gupta\n', '3 people\n');
replace('sh/3mpg3mhw', 'Write it in your own words. Short and specific beats long and polished.', 'Health and Wellbeing · Synthetic demo · Prototype, not for clinical use');

// Slide 3: turn the template's instruction page into the selected problem statement.
title('sh/mt0jydgn', 'Read This First', 'The problem we chose');
replace('sh/7u90rih8', 'BUILD ANYTHING', 'THE CHOSEN PROBLEM');
replace('sh/7u90rih8', 'You are free to build any agentic system you want. The agent can be simple or complex — what matters is that it perceives, reasons, and acts .', 'Patients and caregivers leave hospital with dense instructions and must turn them into safe next steps at home.');
replace('sh/wz214nyp', 'WHAT COUNTS AS AGENTIC', 'PEOPLE AFFECTED');
replace('sh/wz214nyp', 'Your system must do more than respond to prompts. It should plan, use tools, take actions, and handle multi-step tasks with some degree of autonomy.', 'Patients recovering at home and the family members helping manage their care.');
replace('sh/h0bixsza', 'TOOLS AND APIS', 'WHY IT MATTERS');
replace('sh/h0bixsza', 'Use any LLM, framework, or API you like — OpenAI, Anthropic, Gemini, LangChain, CrewAI, custom pipelines. Choose what fits your idea best.', 'Missing dose units, conflicting directions, or vague follow-up details can leave people unsure what to ask next.');
replace('sh/uxkj2xgz', 'JUDGING FOCUS', 'PROBLEM STATEMENT');
replace('sh/uxkj2xgz', "Problem clarity, agentic design, real-world impact, and what you actually shipped in 24 hours. A focused, working agent beats an ambitious idea that doesn't run.", 'How might we help patients and caregivers understand discharge instructions and organize next steps without guessing when details are unclear?');

// Slide 4: affected users, frequency, current workarounds, and their limits.
title('sh/je9oruhs', 'Problem and Existing Solutions', 'Problem and existing workarounds');
replace('sh/wrypwzy1', 'Name the person or team, not "everyone". Max 15 words.', 'Patients and family caregivers managing the move from hospital to home.');
replace('sh/xs76p4zm', 'Per day, per week, per customer. A number if you have one.', 'At each discharge, across pages of instructions and several follow-up tasks.');
replace('sh/apg7upgb', 'Time, money or mistakes. Max 15 words.', 'Time spent searching and cross-checking. Uncertainty can delay a question or routine next step.');
replace('sh/bqponuhg', '2 or 3 real tools or workarounds people use now.', 'Paper discharge packet\nMedication list\nPhone call to clinic or pharmacist\nPersonal notes and calendar');
replace('sh/onypsfy5', 'Max 2 bullets. Be honest, not dismissive.', 'Information is spread across documents and tools.\nUnclear or conflicting instructions still need a person to resolve them.');

// Slide 5: product behavior and bounded agentic workflow.
title('sh/y983uxcv', 'Our Solution', 'How ClearCare works');
replace('sh/lcz2pcvm', 'Plain words, max 3 bullets. Imagine explaining it to a friend.', 'Reads text PDFs locally and extracts instructions with source evidence.\nExplains the original wording in plain language.\nKeeps unclear or high-risk items in review.');
replace('sh/kbqlw7u1', "What reasoning or planning does the agent do? What triggers the next action? How does it know when it's done?", 'Deterministic rules organize and validate document facts. A user click triggers a bounded Care Agent to retrieve relevant evidence and make one AMD request.');
replace('sh/j614z6dk', 'What happens when the agent is stuck, wrong, or unsure? Does it retry, escalate, or ask a human?', 'Missing units, conflicts, unreadable text, or failed checks remain incomplete or need review. Nothing is silently repaired or auto-retried.');
replace('sh/i5s361cz', "What makes this a problem that needs an agent? Why can't a static app or a single API call solve it?", 'A question may need evidence from more than one place. The Care Agent selects document or calendar evidence, then returns a grounded answer with sources. Parsing and calendar rules stay deterministic.');

// Slide 6: product evidence plus technology stack.
title('sh/7ehkri98', 'Wireframes and Tech Stack', 'Product screen and technology');
replace('sh/6t83yd8n', 'WIREFRAMES OR MOCK DIAGRAMS(OPTIONAL)', 'CLEARCARE IN USE');
replace('sh/6t83yd8n', 'Show the screens or flow of your idea. Rough sketches are fine.', 'Original wording stays beside its review status.');
replace('sh/dc3m5wri', 'Tools, models and APIs. Name every sponsor API you use and what for.', 'PDF reading: pdf.js and local deterministic extraction\nApp: JavaScript and Node.js\nAMD: Developer Cloud API, DeepSeek-V4-Flash for user-requested explanations, translation, and Care Agent answers\nVoice and calendar: browser speech APIs and .ics export\nPDF extraction does not use AI. No ROCm claim.');
const slide6 = presentation.slides.items[5];
const shot = await fs.readFile(path.resolve('docs/evidence/explain-ai-mock.png'));
const shotBytes = shot.buffer.slice(shot.byteOffset, shot.byteOffset + shot.byteLength);
slide6.images.add({
  blob: shotBytes,
  contentType: 'image/png',
  alt: 'ClearCare synthetic demo care instructions with source wording and Explain with AMD AI controls',
  fit: 'cover',
  position: { left: 105, top: 420, width: 1000, height: 580 },
  geometry: 'roundRect',
  borderRadius: 'rounded-lg',
});

// Slide 7: explain the data path and the human safety gates.
title('sh/ls76t83e', 'Data Flow', 'How ClearCare handles data');
replace('sh/ypwnyd4n', 'Show how data moves: input  >  agent  >  decision  >  action. Mark every tool call, memory read, or external API the agent uses.\n\n Paste anything that works: a Mermaid chart, an Excalidraw export, a photo of a sketch, any diagram.', '1  Choose PDF; extract embedded text in the browser.\n2  Parse fields with exact source evidence.\n3  Flag ambiguity, conflicts, missing units, and high-risk medicines.\n4  A user click sends selected evidence to AMD.\n5  Verify the answer; withhold unsafe output.\n6  Keep review items unscheduled; export eligible visits to .ics.');

// Slide 8: feasibility, intended users, limits, and next work.
title('sh/rah03y10', 'Feasibility and Impact', 'Feasibility and next steps');
replace('sh/gzq1g32h', 'Rough cost, speed and effort. Anything that could break it?', 'Runs locally for text PDFs. AMD explanations and Care Agent answers need a backend key and network. Scanned PDFs need optional local OCR.');
replace('sh/10j298j2', 'The first 10 users and what gets better for them.', 'Patients and family caregivers get one source-linked checklist and clearer questions to take to their care team.');
replace('sh/ed8jetkr', "One idea you dropped or something that failed, and why.", 'Broad OCR and automatic whole-site translation remain outside this MVP. No caregiver comprehension study has been run.');
replace('sh/feh07y1w', 'Max 3 bullets. What you would build next.', 'Run caregiver comprehension sessions.\nAsk clinicians to review safety language.\nImprove scan support and evaluate more held-out documents.');

// Slide 9: report measured synthetic evaluation with explicit limits.
title('sh/fqdw7yhc', 'Anything Else', 'What the prototype has demonstrated');
replace('sh/ep4fytg7', 'YOUR SPACE', 'SYNTHETIC EVALUATION');
replace('sh/ep4fytg7', 'This page is yours. Fill it with anything that shows your idea: extra screens, numbers, a story, a pitch. Or leave it out.', '110/110 extraction checks passed across 11 synthetic documents, with 0 clinically significant errors recorded. The held-out set passed 32/32 checks. Calendar checks placed 7/7 dated visits correctly, kept 4/4 undated visits off calendar, and created 0 invented visits. These small, hand-written tests do not establish clinical safety or patient comprehension.');

// Slide 10: project references and closing.
title('sh/o7md47il', 'References and Thank You', 'Thank you | ClearCare');
replace('sh/p8vexcj6', 'Max 5 links: docs, papers, repos, datasets you used.', 'PROJECT REPOSITORY\nhttps://github.com/1stsimplifycode/ClearCare-Understand-My-Care-Instructions\n\nAMD API\nhttps://developer.amd.com.cn/radeon/api/v1 · DeepSeek-V4-Flash\n\nEVALUATION\nSynthetic fixtures and measured results: docs/evidence/extraction-eval.json\n\nDEMO VIDEO\nCLEARCARE_AMD_ACT_III_SUBMISSION/videos/CLEARCARE_AMD_ACT_III_DEMO.mp4\n\nSynthetic data only · Prototype, not for clinical use');

await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(outDir, { recursive: true });
const output = path.join(outDir, 'ClearCare_Agentathon_Submission.pptx');
const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(path.join(buildDir, 'candidate.pptx'));
for (let i = 0; i < presentation.slides.items.length; i++) {
  const image = await presentation.export({ slide: presentation.slides.items[i], format: 'png', scale: 1 });
  await fs.writeFile(path.join(buildDir, `slide-${String(i+1).padStart(2, '0')}.png`), new Uint8Array(await image.arrayBuffer()));
}
const summary = await presentation.inspect({ select: '$.slides[*]', include: ['id','index','title','elements.id','elements.kind','elements.text','elements.position'] });
await fs.writeFile(path.join(buildDir, 'content.ndjson'), summary.ndjson, 'utf8');
console.log(`Draft written to ${path.join(buildDir, 'candidate.pptx')}`);
console.log(`Slides rendered: ${presentation.slides.items.length}`);
console.log(summary.ndjson);
