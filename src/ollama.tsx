import { IHookEvent } from "@logseq/libs/dist/LSPlugin.user";
import { BlockEntity, BlockUUIDTuple } from "@logseq/libs/dist/LSPlugin.user";

const delay = (t = 100) => new Promise(r => setTimeout(r, t))

// --- Image handling utilities ---

// Logseq may insert newlines in image markdown, e.g.:
//   !
//   [image.png]
//   (../assets/image_123.png)
// So we use [\s\S] with the 's' flag to match across line breaks.
const IMAGE_REGEX = /!\s*\[.*?\]\s*\(\s*(.*?)\s*\)/gs;

/**
 * Extract image paths from markdown block content.
 * Matches patterns like ![alt](../assets/image_123.png)
 * and Logseq's multiline variant with newlines between parts.
 */
function extractImagePaths(content: string): string[] {
  const paths: string[] = [];
  let match;
  const regex = new RegExp(IMAGE_REGEX.source, IMAGE_REGEX.flags);
  while ((match = regex.exec(content)) !== null) {
    const path = match[1].trim();
    if (path.length > 0) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Resolve a relative image path (e.g. ../assets/image.png) to an absolute
 * filesystem path using the current Logseq graph path.
 *
 * Logseq block content references images as ../assets/filename relative to
 * the pages/ directory, so the absolute path is {graphPath}/assets/{filename}.
 * Also handles already-absolute paths and http(s) URLs.
 */
async function resolveImagePath(relativePath: string): Promise<string> {
  // If it's a URL, return as-is
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
    return relativePath;
  }

  // If it's already absolute, return as-is
  if (relativePath.startsWith('/') || /^[A-Z]:\\/i.test(relativePath)) {
    return relativePath;
  }

  const graph = await logseq.App.getCurrentGraph();
  if (!graph) {
    throw new Error("Could not determine current graph path");
  }

  // ../assets/filename.png → assets/filename.png
  // The relative path is from pages/ dir, so strip leading ../
  const normalized = relativePath.replace(/^\.\.\//, '');
  const graphPath = graph.path.replace(/\/$/, '');
  return `${graphPath}/${normalized}`;
}

/**
 * Read an image file and return its base64 encoding (without data URI prefix).
 * Uses an Image element + Canvas to load and encode the image.
 * Local files are loaded via Logseq's assets:// protocol which is available
 * in the Electron environment.
 */
async function imageToBase64(imagePath: string): Promise<string> {
  let url: string;
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    url = imagePath;
  } else {
    // Use Logseq's assets:// protocol for local files
    const absolutePath = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
    url = `assets://${absolutePath}`;
  }

  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        // Strip the "data:image/png;base64," prefix
        const base64 = dataUrl.split(',')[1];
        resolve(base64);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = (e) => {
      reject(new Error(`Failed to load image: ${url} - ${e}`));
    };
    img.src = url;
  });
}

/**
 * Extract images from block content, resolve their paths, and convert to
 * base64 strings suitable for the Ollama API `images` field.
 * Returns an array of base64-encoded image strings.
 */
async function extractAndEncodeImages(content: string): Promise<string[]> {
  const imagePaths = extractImagePaths(content);
  if (imagePaths.length === 0) {
    return [];
  }

  const base64Images: string[] = [];
  for (const relPath of imagePaths) {
    try {
      const absolutePath = await resolveImagePath(relPath);
      console.log("ollama-logseq: resolved image path:", relPath, "->", absolutePath);
      const base64 = await imageToBase64(absolutePath);
      base64Images.push(base64);
    } catch (e) {
      console.error(`ollama-logseq: Failed to encode image ${relPath}:`, e);
      logseq.UI.showMsg(`Failed to load image: ${relPath}\n${e}`, 'warning');
    }
  }
  return base64Images;
}

/**
 * Remove image markdown syntax from content to produce a clean text prompt.
 */
function stripImageSyntax(content: string): string {
  return content.replace(/!\s*\[.*?\]\s*\(\s*.*?\s*\)/gs, '').trim();
}


export async function ollamaUI() {
  logseq.showMainUI()
  setTimeout(() => {
    const element = document.querySelector(".ai-input") as HTMLInputElement | null;
    if (element) {
      element.focus();
    }
  }, 300)
}

function isBlockEntity(b: BlockEntity | BlockUUIDTuple): b is BlockEntity {
  return (b as BlockEntity).uuid !== undefined;
}

async function getTreeContent(b: BlockEntity) {
  let content = "";
  const trimmedBlockContent = b.content.trim();
  if (trimmedBlockContent.length > 0) {
    content += trimmedBlockContent;
  }

  if (!b.children) {
    return content;
  }

  for (const child of b.children) {
    if (isBlockEntity(child)) {
      content += await getTreeContent(child);
    } else {
      const childBlock = await logseq.Editor.getBlock(child[1], {
        includeChildren: true,
      });
      if (childBlock) {
        content += "\n" + await getTreeContent(childBlock);
      }
    }
  }
  return content;
}

export async function getPageContentFromBlock(b: BlockEntity): Promise<string> {
  let blockContents = [];

  const currentBlock = await logseq.Editor.getBlock(b);
  if (!currentBlock) {
    throw new Error("Block not found");
  }

  const page = await logseq.Editor.getPage(currentBlock.page.id);
  if (!page) {
    throw new Error("Page not found");
  }

  const pageBlocks = await logseq.Editor.getPageBlocksTree(page.name);
  for (const pageBlock of pageBlocks) {
    const blockContent = await getTreeContent(pageBlock);
    if (blockContent.length > 0) {
      blockContents.push(blockContent);
    }
  }
  return blockContents.join(" ");
}

type OllamaGenerateParameters = {
  model?: string;
  [key: string]: any;
}

async function ollamaGenerate(prompt: string, parameters?: OllamaGenerateParameters, images?: string[]) {
  if (!logseq.settings) {
    throw new Error("Couldn't find ollama-logseq settings")
  }

  let params = parameters || {};
  if (params.model === undefined) {
    params.model = logseq.settings.model;
  }
  params.prompt = prompt
  params.stream = false
  if (images && images.length > 0) {
    params.images = images;
  }

  try {
    const response = await fetch(`http://${logseq.settings.host}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params)
    })
    if (!response.ok) {
      logseq.UI.showMsg("Coudln't fulfill request make sure that ollama service is running and make sure there is no typo in host or model name")
      throw new Error("Error in Ollama request: " + response.statusText)
    }
    const data = await response.json()
    return data
  } catch (e: any) {
    console.error("ERROR: ", e)
    logseq.App.showMsg("Coudln't fulfill request make sure that ollama service is running and make sure there is no typo in host or model name")
  }
}

async function promptLLM(prompt: string) {
  if (!logseq.settings) {
    throw new Error("Couldn't find logseq settings");
  }
  try {
    const response = await fetch(`http://${logseq.settings.host}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: logseq.settings.model,
        prompt: prompt,
        stream: false,
      }),
    });
    if (!response.ok) {
      logseq.App.showMsg("Couldn't fulfill request. Make sure Ollama service is running and there are no typos in host or model name.");
      throw new Error("Error in Ollama request: " + response.statusText);
    }

    const data = await response.json();

    // Remove any <think>…</think> blocks in the response
    const filteredResponse = data.response.replace(/<think>[\s\S]*?<\/think>/g, '');

    return filteredResponse;
  } catch (e: any) {
    console.error("ERROR: ", e);
    logseq.App.showMsg("Couldn't fulfill request. Make sure Ollama service is running and there are no typos in host or model name.");
  }
}

export async function defineWord(word: string) {
  askAI(`What's the definition of ${word}?`, "")
}

type ContextType = 'block' | 'page'

export async function askWithContext(prompt: string, contextType: ContextType) {
  try {
    let blocksContent = ""
    if (contextType === 'page') {
      const currentBlocksTree = await logseq.Editor.getCurrentPageBlocksTree()
      for (const block of currentBlocksTree) {
        blocksContent += await getTreeContent(block)
      }
    } else {
      const currentBlock = await logseq.Editor.getCurrentBlock()
      blocksContent += await getTreeContent(currentBlock!)
    }
    askAI(prompt, `Context: ${blocksContent}`)
  } catch (e: any) {
    logseq.App.showMsg(e.toString(), 'warning')
    console.error(e)
  }
}

export async function summarizePage() {
  await delay(300)
  try {
    const currentSelectedBlocks = await logseq.Editor.getCurrentPageBlocksTree()
    let blocksContent = ""
    if (currentSelectedBlocks) {
      let lastBlock: any = currentSelectedBlocks[currentSelectedBlocks.length - 1]
      for (const block of currentSelectedBlocks) {
        blocksContent += block.content + "/n"
      }
      lastBlock = await logseq.Editor.insertBlock(lastBlock.uuid, '⌛ Summarizing Page....', { before: true })
      const summary = await promptLLM(`Summarize the following ${blocksContent}`)
      await logseq.Editor.updateBlock(lastBlock.uuid, `Summary: ${summary}`)
    }
  } catch (e: any) {
    logseq.App.showMsg(e.toString(), 'warning')
    console.error(e)
  }
}

export async function summarizeBlock() {
  try {
    // TODO: Get contnet of current block and subblocks
    const currentBlock = await logseq.Editor.getCurrentBlock()
    let summaryBlock = await logseq.Editor.insertBlock(currentBlock!.uuid, `⌛Summarizing Block...`, { before: false })
    const summary = await promptLLM(`Summarize the following ${currentBlock!.content}`);

    await logseq.Editor.updateBlock(summaryBlock!.uuid, `Summary: ${summary}`)
  } catch (e: any) {
    logseq.App.showMsg(e.toString(), 'warning')
    console.error(e)
  }
}



async function getOllamaParametersFromBlockProperties(b: BlockEntity) {
  const properties = await logseq.Editor.getBlockProperties(b.uuid);
  const ollamaParameters: OllamaGenerateParameters = {}
  const prefix = 'ollamaGenerate'
  for (const property in properties) {
    if (property.startsWith(prefix)) {
      const key = property.replace(prefix, '').toLowerCase()
      ollamaParameters[key] = properties[property]
    }
  }
  return ollamaParameters
}

async function getOllamaParametersFromBlockAndParentProperties(b: BlockEntity) {
  let ollamaParentProperties: OllamaGenerateParameters = {}
  if (b.parent) {
    let parentBlock = await logseq.Editor.getBlock(b.parent.id)
    if (parentBlock)
      ollamaParentProperties = await getOllamaParametersFromBlockProperties(parentBlock)
  }
  const ollamaBlockProperties = await getOllamaParametersFromBlockProperties(b)
  return { ...ollamaParentProperties, ...ollamaBlockProperties }
}

async function promptFromBlock(block: BlockEntity, prefix?: string) {
  const answerBlock = await logseq.Editor.insertBlock(block!.uuid, '🦙Generating ...', { before: false })
  const params = await getOllamaParametersFromBlockAndParentProperties(block!)
  const blockContent = await getTreeContent(block);

  // Extract images from block content and encode as base64
  const images = await extractAndEncodeImages(blockContent);

  // Strip image syntax from the prompt text so the LLM gets clean text
  let prompt = images.length > 0 ? stripImageSyntax(blockContent) : blockContent;
  if (prefix) {
    prompt = prefix + "\n" + prompt
  }

  // If the block only contained an image and no text, provide a default prompt
  if (images.length > 0 && prompt.trim().length === 0) {
    prompt = prefix || "Describe this image in detail.";
  }

  const result = await ollamaGenerate(prompt, params, images);

  //FIXME: work out the best way to story context
  if (params.usecontext) {
    await logseq.Editor.upsertBlockProperty(block!.uuid, 'ollama-generate-context', result.context)
  }

  await logseq.Editor.updateBlock(answerBlock!.uuid, `${result.response}`)
}

export function promptFromBlockEventClosure(prefix?: string) {
  return async (event: IHookEvent) => {
    try {
      const currentBlock = await logseq.Editor.getBlock(event.uuid)
      await promptFromBlock(currentBlock!, prefix)
    } catch (e: any) {
      logseq.UI.showMsg(e.toString(), 'warning')
      console.error(e)
    }
  }
}

/**
 * Describe images found in a block. Extracts all images from the block content,
 * sends them to Ollama with a description prompt, and inserts the response
 * as a child block.
 */
export async function describeImageFromEvent(b: IHookEvent) {
  try {
    const block = await logseq.Editor.getBlock(b.uuid)
    if (!block) {
      throw new Error("Block not found")
    }

    const blockContent = block.content;
    console.log("ollama-logseq: block content:", JSON.stringify(blockContent));
    console.log("ollama-logseq: extracted image paths:", extractImagePaths(blockContent));
    const images = await extractAndEncodeImages(blockContent);

    if (images.length === 0) {
      logseq.UI.showMsg(`No images found in this block. Content: ${blockContent.substring(0, 200)}`, 'warning')
      return;
    }

    const answerBlock = await logseq.Editor.insertBlock(block.uuid, '🦙Describing image...', { before: false })
    const params = await getOllamaParametersFromBlockAndParentProperties(block)

    // Use any non-image text in the block as additional context, otherwise use default prompt
    const textContent = stripImageSyntax(blockContent).trim();
    const prompt = textContent.length > 0
      ? `Describe this image. Additional context: ${textContent}`
      : "Describe this image in detail.";

    const result = await ollamaGenerate(prompt, params, images);
    await logseq.Editor.updateBlock(answerBlock!.uuid, `${result.response}`)
  } catch (e: any) {
    logseq.UI.showMsg(e.toString(), 'warning')
    console.error(e)
  }
}

export async function askAI(prompt: string, context: string) {
  await delay(300)
  try {
    const currentBlock = await logseq.Editor.getCurrentBlock()
    let block = null;
    if (currentBlock?.content.trim() === '') {
      block = await logseq.Editor.insertBlock(currentBlock!.uuid, '⌛Generating....', { before: true })
    } else {
      block = await logseq.Editor.insertBlock(currentBlock!.uuid, '⌛Generating....', { before: false })
    }
    let response = "";
    if (context == "") {
      response = await promptLLM(prompt)
    } else {
      response = await promptLLM(`With the context of: ${context}, ${prompt}`)
    }
    await logseq.Editor.updateBlock(block!.uuid, `${prompt}\n${response}`)
  } catch (e: any) {
    logseq.App.showMsg(e.toString(), 'warning')
    console.error(e)
  }
}

export async function convertToFlashCard(uuid: string, blockContent: string) {
  try {
    const questionBlock = await logseq.Editor.insertBlock(uuid, "⌛Generating question....", { before: false })
    const answerBlock = await logseq.Editor.insertBlock(questionBlock!.uuid, "⌛Generating answer....", { before: false })
    const question = await promptLLM(`Create a question for a flashcard. Provide the question only. Here is the knowledge to check:\n ${blockContent}`)
    const answer = await promptLLM(`Given the question ${question} and the context of ${blockContent} What is the answer? be as brief as possible and provide the answer only.`)
    await logseq.Editor.updateBlock(questionBlock!.uuid, `${question} #card`)
    await delay(300)
    await logseq.Editor.updateBlock(answerBlock!.uuid, answer)
  } catch (e: any) {
    logseq.App.showMsg(e.toString(), 'warning')
    console.error(e)
  }
}

export async function convertToFlashCardFromEvent(b: IHookEvent) {
  const currentBlock = await logseq.Editor.getBlock(b.uuid)
  await convertToFlashCard(currentBlock!.uuid, currentBlock!.content)
}

export async function convertToFlashCardCurrentBlock() {
  const currentBlock = await logseq.Editor.getCurrentBlock()
  await convertToFlashCard(currentBlock!.uuid, currentBlock!.content)
}

export async function DivideTaskIntoSubTasks(uuid: string, content: string) {
  try {
    // 1) Insert initial placeholder block.
    const placeholderBlock = await logseq.Editor.insertBlock(
      uuid,
      "✅ Generating todos ...",
      { before: false }
    );
    if (!placeholderBlock) {
      throw new Error("Could not insert the placeholder block.");
    }

    // 2) Fetch LLM response
    const response = await promptLLM(
      `Divide this task into subtasks with numbers respond with multilevel nested markdown format, no dot notation, one subtask per line, plain text only.: ${content}`
    );

    // 3) Split on newlines, ignoring empty lines
    const lines = response
      .split("\n")
      .map((line: string) => line.replace(/\r$/, ""))  // remove trailing \r if present
      .filter((line: string) => line.trim().length > 0);

    // If there's nothing, do nothing
    if (!lines.length) return;

    // 4) Update the placeholder block with the very first line
    //    preserving its entire text (no slicing or removal).
    //    Prepend “TODO ” as in your original code structure.
    await logseq.Editor.updateBlock(
      placeholderBlock.uuid,
      `TODO ${lines[0]}`
    );

    // If there was only one line, we’re done
    if (lines.length === 1) return;

    // 5) Now set up stack-based nesting for the rest:
    //    stack top is always the most recent block at a particular level.
    //    We'll treat the placeholder block as level=0
    const stack = [{ uuid: placeholderBlock.uuid, level: 0 }];

    // Helper: Determine indent-based nesting level.
    // Adjust baseIndent if your model uses different spacing for sub-levels.
    function getIndentLevel(line: string): number {
      const firstCharIndex = line.search(/\S/);
      // no non-whitespace => treat as top-level
      if (firstCharIndex < 0) {
        return 0;
      }
      // e.g. baseIndent=2 → each 2 leading spaces => +1 nesting level
      const baseIndent = 3;
      return Math.floor(firstCharIndex / baseIndent);
    }

    // 6) Process remaining lines to handle nesting
    for (let i = 1; i < lines.length; i++) {
      const rawLine = lines[i];

      // figure out “level” from indentation
      const level = getIndentLevel(rawLine);

      // pop the stack until we find a block whose level is < current level
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      // if the stack is empty (all popped), fallback to the placeholder:
      if (stack.length === 0) {
        stack.push({ uuid: placeholderBlock.uuid, level: 0 });
      }

      // top of stack is the parent block where we create a child
      const parent = stack[stack.length - 1];

      // Insert a child block. Trim only leading spaces from the line’s text so we keep the numbering/content
      const trimmedText = rawLine.replace(/^\s+/, "");
      const newBlock = await logseq.Editor.insertBlock(
        parent.uuid,
        `TODO ${trimmedText}`,
        { sibling: false }
      );

      if (newBlock) {
        // push newly inserted block at the correct level
        stack.push({ uuid: newBlock.uuid, level });
      }
    }
  } catch (e: any) {
    logseq.App.showMsg(e.toString(), "warning");
    console.error(e);
  }
}

export async function DivideTaskIntoSubTasksFromEvent(b: IHookEvent) {
  const currentBlock = await logseq.Editor.getBlock(b.uuid)
  DivideTaskIntoSubTasks(currentBlock!.uuid, currentBlock!.content)
}

export async function DivideTaskIntoSubTasksCurrentBlock() {
  const currentBlock = await logseq.Editor.getCurrentBlock()
  DivideTaskIntoSubTasks(currentBlock!.uuid, currentBlock!.content)
}

