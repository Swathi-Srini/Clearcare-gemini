import path from 'node:path';
import { pathToFileURL } from 'node:url';
const skill = 'C:/Users/Swathi/.codex/plugins/cache/openai-primary-runtime/presentations/26.1015.12040/skills/presentations';
const { finalizePresentation } = await import(pathToFileURL(path.join(skill, 'container_tools/artifact_tool_utils.mjs')).href);
const workspaceDir = 'D:/AMD';
const result = await finalizePresentation({
  workspaceDir,
  candidatePath: 'D:/AMD/.clearcare-pptx-build/candidate.pptx',
  finalPath: 'D:/AMD/CLEARCARE_AMD_ACT_III_SUBMISSION/ClearCare_Agentathon_Submission.pptx',
  pythonExecutable: 'C:/Users/Swathi/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
  integrityValidatorPath: path.join(skill, 'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath: path.join(skill, 'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs: ['--expected-slide-size-emu', '18288000,10287000', '--validate-bullet-geometry', '--validate-heading-fit'],
  explicitTotalSlideCount: 10,
  requiredNativeTableOwnerSlides: [],
  requiredNativeChartOwnerSlides: [],
  fontPolicy: {basis:'reference', families:['Arial'], referencePath:'C:/Users/Swathi/Downloads/Copy of Agentathon-Template.pptx', referenceSha256:'61210eec4bbe137bcd097eaaabc02a71d4ad757e695887a204cf475429d8fa6e'},
  verifyArtifactToolImport: true,
  receiptPath: 'D:/AMD/.clearcare-pptx-build/ClearCare_Agentathon_Submission.validation.json',
});
console.log(JSON.stringify(result,null,2));


