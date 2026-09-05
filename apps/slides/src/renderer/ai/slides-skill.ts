import type { AgentSkill, ToolDisplay } from '@genoffice/agent-core'
import {
  anchorPoint,
  auditHorizontalPipeline,
  parseFigureContract,
  DOMAIN_PROFILES,
  auditInputCoreOutput,
  endpointTable,
  getComponentSpec,
  SEMANTIC_NODE_STYLES,
  layoutHorizontalPipeline,
  layoutInputCoreOutput,
  layoutMicro,
  normalizeVisualPlan,
  orchestrateFigure,
  parseSemanticEdges,
  ROLE_SHAPE,
  shapePreset,
  type CapabilityInput,
  type Rect as RouteRect,
} from '@genoffice/research-harness'
import type { FigurePlan } from '@genoffice/research-harness'
import {
  AGENT_SYSTEM_PROMPT,
  RESEARCH_AGENT_SYSTEM_PROMPT,
  RESEARCH_COMPOSITION_DESIGNER_PROMPT,
  RESEARCH_SEMANTIC_PLANNER_PROMPT,
} from '../../shared/prompt-defaults'
import { effectivePrompt } from './prompt-overrides'
import {
  beginAction,
  commitAction,
  completeAction,
  revertAction,
} from '@genoffice/research-harness'
import {
  componentThemeTokens,
  connectorColor,
  getThemeById,
  resolveComponentColors,
} from '@genoffice/theme-engine'
import type {
  GroupRenderNode,
  PictureRenderNode,
  RenderNode,
  RenderSlide,
  ShapeRenderNode,
} from '@genoffice/pptx-render'
import type { AddSmartArtOp, AgentToolCall, AgentToolDef, EditParagraph } from '../../shared/ipc'
import { opVocabulary } from '../../shared/op-docs'
import { auditSlideLayout, formatAudit } from './layout-audit'
import { runLayoutScript, type LayoutScriptElement, type SlideStylePatch } from './layout-script'
import { t } from '../i18n/locale'

/**
 * Slides capability as an AgentSkill: deck outline context + three tools (read structure /
 * read one slide / edit element text). Changes go through the existing slides:edit-text IPC;
 * the main process applies them and returns the new RenderSlide, which applySlide writes
 * back into React state — the same pipeline as manual editing.
 */

// ── Generation progress events (for the onProgress callback; renderer memory only, never persisted or journaled) ──

/** Per-page progress status */
export type PageProgressStatus = 'pending' | 'running' | 'done' | 'error'

/** Per-page progress entry */
export interface PageProgressItem {
  title: string
  status: PageProgressStatus
  /** Failure reason (when status='error'); cleared after a successful retry */
  error?: string
}

/** Progress event union type (all stages share one callback; the UI dispatches by stage) */
export type DeckProgressEvent =
  | { stage: 'style'; label: string; status: 'running' | 'done' | 'error'; summary: string }
  | {
      stage: 'plan'
      label: string
      done: number
      total: number
      status: 'running' | 'done' | 'error'
      summary: string
    }
  | {
      stage: 'images'
      label: string
      done: number
      total: number
      status: 'running' | 'done' | 'error'
      summary: string
    }
  | {
      stage: 'pages'
      label: string
      done: number
      total: number
      status: 'running' | 'done' | 'error'
      summary: string
      pages: PageProgressItem[]
    }
  | { stage: 'done'; total: number; summary: string }

/** Panel/skill access point to the currently open deck (refs provided by App, stay fresh across renders). */
export interface DeckAccess {
  getSlides(): RenderSlide[]
  getCurrent(): number
  getSelectedIds(): string[]
  applySlide(slideIndex: number, updated: RenderSlide): void
  /** Replace the whole deck (after adding/removing slides) and jump to the goTo slide */
  applyDeck(slides: RenderSlide[], goTo?: number): void
  /**
   * Generation progress callback (optional): called by generate_deck stages; the UI updates
   * the progress card and top progress bar in real time. Passed only through renderer
   * memory, never persisted or journaled.
   */
  onProgress?(event: DeckProgressEvent): void
  /** Land generated pages: each pageMarkers entry redeems a one-slide pptx, merged into / replacing the current deck. Returns total page count or an error.
   *  mode="insert_at" inserts a single page at position insertAt (later pages shift) — used to re-insert failed pages at their original position.
   *  On pipeline failure it automatically falls back to element-level mode; fallbackReason explains why (ok is still true).
   *  deckName = presentation name derived from user input, used as the file name when the new draft is saved (instead of "Untitled-timestamp"). */
  landGeneratedPages?(
    pageMarkers: string[],
    mode?: 'replace' | 'append' | 'insert_at',
    deckName?: string,
    insertAt?: number,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    pages?: number
    appendedFrom?: number
    insertedIndex?: number
    error?: string
    fallbackReason?: string
    imageFailures?: { page: number; url: string }[]
  }>
  /** Redo one slide in place: land the marker's page as a replacement for slide slideIndex (other slides untouched; undoable with ⌘Z). */
  regenerateSlide?(
    slideIndex: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string; imageFailures?: { page: number; url: string }[] }>
  /** Survey: shows a card with options and waits for the user's choices, returning an answer summary. */
  askClarification?(questions: ClarifyQuestion[]): Promise<{ answers: string; cancelled?: boolean }>
  /**
   * Overwrite the speaker notes of a page (persisted into the pptx notesSlide part,
   * undoable, marks the document dirty). Empty text clears the notes.
   */
  setSpeakerNotes?(slideIndex: number, text: string): Promise<boolean>
  /**
   * In-tool image search (embedded in the tool):
   * given English keywords, returns an array of real image URLs (at most N).
   * On search failure returns an empty array (fail-open; doesn't block the main generation path).
   */
  searchImages?(query: string, maxResults: number): Promise<string[]>
  /** Whether cloud single-page generation is available (kill switch + gsk login state) */
  isCloudPageGenEnabled?(): Promise<boolean>
  /** Creation Orchestrator: one raw schema-contract LLM call with the user's own model */
  runLlm?(system: string, user: string): Promise<{ ok: boolean; text?: string; error?: string }>
  /** live predicate: gsk login && the Genspark-cloud-tools toggle; false hides generate_image / analyze_media */
  gskTools?(): boolean
  /**
   * Cloud single-page generation (gsk slide_generate), used by generate_deck's self-driven
   * pipeline: given the unified style + this page's brief/layout/images, the cloud service
   * writes the HTML and converts it to a one-slide pptx. Returns a marker string that goes
   * into a landGeneratedPages pageMarkers slot.
   */
  generatePageCloud?(args: {
    pageIndex: number
    totalPages: number
    coreHook: string
    style: string
    title: string
    brief: string
    layout: string
    images: string[]
    context?: string
    topic?: string
    canvasW: number
    canvasH: number
    signal?: AbortSignal
  }): Promise<{ ok: boolean; marker?: string; error?: string }>
  /**
   * Local single-page generation (used when cloud is unavailable, e.g. BYOK without gsk):
   * same inputs and marker contract as generatePageCloud, but the page is produced entirely
   * locally — one LLM request writes a structured slide spec and the main process builds it
   * directly into a one-slide pptx (no HTML intermediate).
   */
  generatePageLocal?(args: {
    pageIndex: number
    totalPages: number
    coreHook: string
    style: string
    title: string
    brief: string
    layout: string
    images: string[]
    context?: string
    topic?: string
    canvasW: number
    canvasH: number
    signal?: AbortSignal
  }): Promise<{ ok: boolean; marker?: string; error?: string; imageFailures?: string[] }>
  /**
   * In-tool Style Skill generation:
   * a dedicated LLM call focused on producing a complete structured visual style guide
   * (color rules/fonts/layout variants per page type/overall style). Promotes style from an
   * "outline side-product" to a "dedicated deliverable" — less AI-looking, consistent across pages.
   */
  generateStyleSkill?(args: {
    topic: string
    questionnaire?: string
    styleHint?: string
    signal?: AbortSignal
  }): Promise<{ ok: boolean; styleSkill?: string; error?: string }>
  /**
   * In-tool planning: given topic + page count, the LLM produces a structured outline.
   * Fixes "missing pages at the input side" at the root — the main agent doesn't hand-write dozens of pages of pages JSON (avoids the argument being truncated by max_tokens).
   * style is already produced by generateStyleSkill; this function only outputs core_hook + per-page outlines (styleSkill serves as a reference for consistency).
   * Batched recursion is scheduled by the skill (continueFrom keeps the narrative coherent across batches).
   */
  planDeckOutline?(args: {
    topic: string
    count: number
    startPage: number
    context?: string
    styleSkill?: string
    continueFrom?: { coreHook: string }
    signal?: AbortSignal
  }): Promise<{
    ok: boolean
    // Same loose shape as OutlineJson (outline-json.ts): the LLM output is
    // only validated field-by-field at the point of use.
    outline?: { core_hook?: unknown; pages?: unknown }
    error?: string
  }>
  /**
   * Persist the current draft's Style Skill as a sidecar file (same directory and name as the draft, .styleskill.json).
   * fail-open: failure doesn't block the main path.
   */
  saveSidecar?(data: { topic: string; styleSkill: string; createdAt: string }): Promise<void>
  /**
   * Save styleSkill into userData/style-templates/<name>.json for later reuse.
   */
  saveStyleTemplate?(
    name: string,
    data: { topic: string; styleSkill: string; createdAt: string },
  ): Promise<{ ok: boolean; error?: string }>
  /**
   * List saved Style templates (name + topic + createdAt).
   */
  listStyleTemplates?(): Promise<Array<{ name: string; topic: string; createdAt: string }>>
  /**
   * Load the content of a given Style template.
   */
  loadStyleTemplate?(
    name: string,
  ): Promise<{ ok: boolean; styleSkill?: string; topic?: string; error?: string }>
  fitWidthPx: number
  /** Base retry backoff in ms for single-page generation failures (default 2000; tests pass 0 to disable backoff) */
  retryBackoffMs?: number
  /**
   * Names of text attachments in the current conversation that were never read with
   * read_attachment. When non-empty, generate_deck refuses to run until they are read
   * (decks must be built from attachment content, not generic filler).
   */
  unreadTextAttachments?(): string[]
}

/** Single survey question structure (with options). */
export interface ClarifyQuestion {
  id: string
  label: string
  description?: string
  /** Option text array (≤5 per question); the frontend automatically appends "Other (fill in)" */
  options: string[]
  /** Multi-select (single-select by default) */
  multi?: boolean
}

/** Paragraph schema (shared by set_element_text / add_text_box / add_shape) */
const PARAGRAPHS_DEF = {
  paragraphs: {
    type: 'array',
    description: 'Complete paragraph list, one object per paragraph',
    items: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Paragraph plain text' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        fontSize: { type: 'number', description: 'Font size (pt)' },
        fontFamily: {
          type: 'string',
          description: 'Font name; omit to inherit the theme font (recommended)',
        },
        color: { type: 'string', description: '#RRGGBB' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
      },
      required: ['text'],
    },
  },
} as const

interface ToolParagraph {
  text?: unknown
  bold?: boolean
  italic?: boolean
  underline?: boolean
  fontSize?: number
  fontFamily?: string
  color?: string
  align?: 'left' | 'center' | 'right'
}

function toEditParagraphs(raw: unknown): EditParagraph[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  return raw.map((p) => {
    const para = p as ToolParagraph
    return {
      runs: [
        {
          text: String(para.text ?? ''),
          ...(para.bold ? { bold: true } : {}),
          ...(para.italic ? { italic: true } : {}),
          ...(para.underline ? { underline: true } : {}),
          ...(typeof para.fontSize === 'number' ? { fontSize: para.fontSize } : {}),
          ...(para.fontFamily ? { fontFamily: para.fontFamily } : {}),
          ...(para.color ? { color: para.color } : {}),
        },
      ],
      ...(para.align ? { align: para.align } : {}),
    }
  })
}

const TOOLS: AgentToolDef[] = [
  {
    name: 'get_deck_context',
    description:
      "Get the deck's latest outline: per-page list of text elements (element id | type | text preview). Call to confirm global state after edits.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_slide',
    description:
      'Read all elements of a page with full text (untruncated) and current colors (fill/text/stroke, hex). Call before rewriting a page.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
      },
      required: ['slideIndex'],
    },
  },
  {
    name: 'set_element_text',
    description:
      "Replace a text element's entire content. paragraphs is the complete post-replacement paragraph array, one object per paragraph; whole-paragraph bold/italic etc. use the boolean fields on the paragraph object.",
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        sourceId: { type: 'string', description: 'Element id (from the outline/read_slide)' },
        paragraphs: { $ref: '#/definitions/paragraphs' },
      },
      required: ['slideIndex', 'sourceId', 'paragraphs'],
      definitions: PARAGRAPHS_DEF,
    },
  },
  {
    name: 'set_element_style',
    description:
      "Change an element's text formatting without changing the text: font size/color/bold/italic/underline/alignment/font. " +
      "Pass only the fields to change; others stay as-is. Applies to the element's entire text.",
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        sourceId: { type: 'string', description: 'Element id' },
        fontSize: { type: 'number', description: 'Font size (pt)' },
        color: { type: 'string', description: '#RRGGBB' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        fontFamily: { type: 'string', description: 'Font name; usually omit to inherit the theme' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
      },
      required: ['slideIndex', 'sourceId'],
    },
  },
  {
    name: 'set_element_transform',
    description:
      'Move/resize/rotate an element (pixel coordinates, origin top-left, canvas 1280 wide). Pass only the fields to change; others keep their values.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string' },
        x: { type: 'number', description: 'Top-left x (px)' },
        y: { type: 'number', description: 'Top-left y (px)' },
        w: { type: 'number', description: 'Width (px)' },
        h: { type: 'number', description: 'Height (px)' },
        rotationDeg: { type: 'number', description: 'Rotation angle (degrees, clockwise)' },
      },
      required: ['slideIndex', 'sourceId'],
    },
  },
  {
    name: 'execute_slide_script',
    description:
      "[Preferred tool for editing a slide's existing elements] Runs your JS edit script against one page; a single script covers: position/size/alignment/distribution/relative nudges/text/style/fill/stroke." +
      ' At run time the script automatically receives the real geometry and text of every element on the page (els) — **no read_slide needed first**; read-write combined, compute from els inside the script.' +
      ' The whole script is one atomic transaction: geometry in one batch, the rest in script order, one undo step; if any operation fails, everything rolls back and the page is unchanged — fix the script and resend it whole. A layout audit (overlap/out-of-bounds/text overflow) is returned at the end.' +
      ' Far more reliable than individual set_element_* calls — coordinate math happens at execution site, not from memory. If the audit reports problems, call this tool again immediately to fix.\n' +
      'Script environment (constrained synchronous JS-like DSL; no external APIs or ambient globals):\n' +
      '- els: array, each item {id,type,text,x,y,w,h,rotation,fontSizePt?,fill?,textColor?,strokeColor?,inGroup?,groupId?,locked?} (pixels, origin top-left; fill/textColor/strokeColor are current colors in #RRGGBB, read-only — write via setFill/setStyle/setStroke; inGroup+groupId=directly editable group child (all primitives work, coordinates absolute as shown); inGroup without groupId=nested in a sub-group, read-only — ungroup_element the outer group first; locked=layout decoration, read-only)\n' +
      '- canvas: {w,h} canvas size (px)\n' +
      "- setBox(id, {x?,y?,w?,h?,rotation?}): set an element's target box, pass only fields to change\n" +
      '- moveBy(id, dx, dy): relative move (left = negative dx, up = negative dy)\n' +
      '- resizeBy(id, dw, dh): relative resize\n' +
      "- setText(id, textOrParagraphs): replace text entirely; pass a string (split into paragraphs by \\n) or a paragraph array (same format as set_element_text's paragraphs)\n" +
      '- setStyle(id, {fontSize?,color?,bold?,italic?,underline?,align?,fontFamily?}): change style without changing text, pass only fields to change\n' +
      "- setFill(id, colorOrNone): solid fill '#RRGGBB' or 'none'\n" +
      '- setStroke(id, {color?,widthPt?} | null): stroke; pass null to remove\n' +
      '- log(...): debug output (echoed back to you); the return value is echoed back to you (put a summary there)\n' +
      '- Supported computation: const/let, arithmetic, if/for/for...of/while, functions/arrows, JSON object/array literals, Math, regex.test, and safe array/string methods. No classes, async, modules, constructors, prototypes, or dynamic code.\n' +
      'Example 1 — three cards equal width, equal spacing:\n' +
      'const cards = els.filter(e => /card/.test(e.id));\n' +
      'const gap = 32, w = (canvas.w - 2*80 - (cards.length-1)*gap) / cards.length;\n' +
      'cards.forEach((c, i) => setBox(c.id, { x: 80 + i*(w+gap), y: 200, w, h: 320 }));\n' +
      "Example 2 — move the title left a bit: moveBy('title', -30, 0);\n" +
      "Example 3 — make the title blue and bold: setStyle('t1', { color: '#1a73e8', bold: true });",
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        code: {
          type: 'string',
          description:
            'JS script body (synchronous code; may use els/canvas plus setBox/moveBy/resizeBy/setText/setStyle/setFill/setStroke/log; may return a summary)',
        },
        explanation: {
          type: 'string',
          description:
            'One sentence describing what this script does (≤60 chars, shown to the user)',
        },
      },
      required: ['slideIndex', 'code'],
    },
  },
  {
    name: 'set_element_fill',
    description: 'Set an element\'s solid fill. fill=#RRGGBB; pass "none" for no fill.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string' },
        fill: { type: 'string', description: '#RRGGBB or none' },
      },
      required: ['slideIndex', 'sourceId', 'fill'],
    },
  },
  {
    name: 'set_element_stroke',
    description:
      "Set an element's stroke. Pass color (#RRGGBB) + widthPt (points); to remove the stroke pass remove=true.",
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string' },
        color: { type: 'string', description: '#RRGGBB' },
        widthPt: { type: 'number', description: 'Line width (points), default 1' },
        remove: { type: 'boolean', description: 'true = remove stroke' },
      },
      required: ['slideIndex', 'sourceId'],
    },
  },
  {
    name: 'web_search',
    description:
      'Web search for text information (material/data/facts). Use when you need current information or are unsure about facts. Returns title/link/snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        maxResults: { type: 'integer', description: 'Max results, default 6' },
      },
      required: ['query'],
    },
  },
  {
    name: 'image_search',
    description:
      'Search image assets (for slide imagery). Returns a list of imageUrl; after choosing, insert with insert_web_image.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Image search keywords (English works better)' },
        maxResults: { type: 'integer', description: 'Max results, default 8' },
      },
      required: ['query'],
    },
  },
  {
    name: 'generate_image',
    description:
      'AI image generation/editing. Text-to-image, or pass referenceImageUrls for image editing; returns an image URL. NEW imagery: insert with insert_web_image. Editing an EXISTING slide picture (background removal/upscaling/etc.): swap it in place with replace_image — do not insert a duplicate. Use for custom illustrations/icons/backgrounds, style-consistent imagery; for real photos/screenshots still use image_search.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Image description, English works better (keep any text to render in the image verbatim)',
        },
        model: {
          type: 'string',
          description:
            'Optional, defaults to the general model. Specify only for special purposes: fal-bria-rmbg=background removal, fal-ai/recraft-clarity-upscale=upscale, flux-pro/outpaint=outpaint, fal-ai/image-editing/text-removal=remove text watermark',
        },
        referenceImageUrls: {
          type: 'array',
          items: { type: 'string' },
          description: 'URLs of reference images / images to edit (required for editing tasks)',
        },
        aspectRatio: {
          type: 'string',
          description: 'Aspect ratio: 1:1|4:3|16:9|9:16|3:4|2:3|3:2|auto',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'analyze_media',
    description:
      'Analyze media content: understand images/audio/video. Pass media URLs (or local file paths) and analysis requirements; returns analysis text. Video supports extracting key points, structure, and time ranges — good for turning user material into usable deck content.',
    inputSchema: {
      type: 'object',
      properties: {
        mediaUrls: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of media URLs or local file paths',
        },
        requirements: {
          type: 'string',
          description:
            'Analysis requirements (English): what to extract and how the result will be used (e.g. extract key points for slides)',
        },
      },
      required: ['mediaUrls', 'requirements'],
    },
  },
  {
    name: 'insert_web_image',
    description:
      'Download an image URL obtained from image_search or generate_image and insert it into a page (pixel coordinates). w×h is a layout frame, not a stretch target: the image keeps its aspect ratio, fills the frame, and the overflow is center-cropped (object-fit: cover) — pick the frame for the layout freely.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        url: { type: 'string', description: 'Direct image link (imageUrl from image_search)' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['slideIndex', 'url', 'x', 'y', 'w', 'h'],
    },
  },
  {
    name: 'crop_image',
    description:
      'Crop a picture non-destructively (srcRect): l/t/r/b are fractions (0..1) cut from each edge of the source image. The element frame stays where it is; the remaining region stretches to fill it. Pass all zeros to remove an existing crop.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Picture element id' },
        l: { type: 'number', description: 'Fraction cut from the left edge (0..1)' },
        t: { type: 'number', description: 'Fraction cut from the top edge (0..1)' },
        r: { type: 'number', description: 'Fraction cut from the right edge (0..1)' },
        b: { type: 'number', description: 'Fraction cut from the bottom edge (0..1)' },
      },
      required: ['slideIndex', 'sourceId', 'l', 't', 'r', 'b'],
    },
  },
  {
    name: 'set_picture_opacity',
    description:
      "Set a picture's whole-image opacity. opacity 0..1; 1 = fully opaque (removes the effect).",
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Picture element id' },
        opacity: { type: 'number', description: '0 (invisible) .. 1 (opaque)' },
      },
      required: ['slideIndex', 'sourceId', 'opacity'],
    },
  },
  {
    name: 'replace_image',
    description:
      'Swap a picture\'s source image for a URL (from image_search or generate_image) in place — position, size, z-order, border and effects all survive. This is the tool for "change/AI-edit this image" flows: e.g. run generate_image with referenceImageUrls for background removal/upscaling/editing, then replace_image with the returned URL. A new image with a different aspect ratio is never stretched: it fills the frame and is center-cropped (object-fit: cover). keepCrop keeps the existing crop window and is only correct when the new image has the same pixel geometry as the old one (e.g. background removal output).',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Picture element id' },
        url: { type: 'string', description: 'Direct image link' },
        keepCrop: { type: 'boolean', description: 'Keep the existing crop window (default false)' },
      },
      required: ['slideIndex', 'sourceId', 'url'],
    },
  },
  {
    name: 'ask_clarification',
    description:
      "[Call before creating a whole new figure] Shows a questionnaire card with options, letting the user make key choices for this figure (audience/scenario/tone/focus etc.); the user's choices directly determine the figure plan. Questions must target the specific topic, each being a real trade-off (options represent different directions). Ask 2–4 questions, ≤5 options each. After calling, wait for the user to finish choosing and then call the appropriate planning tool. Don't repeat the questions in your reply text.",
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Question list (2–4 questions)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique question id (short English/pinyin)' },
              label: { type: 'string', description: 'Question text' },
              description: { type: 'string', description: 'Optional one-line note' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Options (≤5); the frontend automatically appends "Decide for me" and "Other"',
              },
              multi: { type: 'boolean', description: 'Multi-select (single-select by default)' },
            },
            required: ['id', 'label', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'plan_research_figure',
    description:
      '[Research Figure Mode] Validates and echoes a FigurePlan before a research Recipe creates native editable elements. Include the figure type, reading direction, semantic regions, component nodes, relationship edges, and negative constraints. Do not include pixel coordinates; the Recipe owns geometry.',
    inputSchema: {
      type: 'object',
      properties: {
        figureType: {
          type: 'string',
          enum: ['input-core-output', 'horizontal-pipeline'],
        },
        readingDirection: { type: 'string', enum: ['LR', 'TB'] },
        regions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              role: { type: 'string', enum: ['input', 'core', 'output', 'context', 'feedback'] },
            },
            required: ['id', 'role'],
          },
        },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              region: { type: 'string' },
              component: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['region', 'component', 'title'],
          },
        },
        edges: {
          type: 'array',
          description:
            'The ONLY source of connector topology — the Recipe never infers relationships from node order. Region-level refs expand to every member.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Existing region id or node title' },
              to: { type: 'string', description: 'Existing region id or node title' },
              role: { type: 'string', enum: ['main', 'feedback', 'annotation'] },
              relation: {
                type: 'string',
                enum: [
                  'causal',
                  'process',
                  'data-flow',
                  'transformation',
                  'promotion',
                  'inhibition',
                  'mediation',
                  'moderation',
                  'feedback',
                  'hypothesis',
                  'association',
                  'mapping',
                  'hierarchy',
                  'bidirectional',
                ],
                description: 'Scientific relation type; defaults to process.',
              },
              label: { type: 'string', description: 'Optional short edge label (≤8 chars ideal)' },
            },
            required: ['from', 'to', 'role'],
          },
        },
        negativeConstraints: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'figureType',
        'readingDirection',
        'regions',
        'nodes',
        'edges',
        'negativeConstraints',
      ],
    },
  },
  {
    name: 'plan_deck',
    description:
      '[Research Figure Mode] Outputs a structured FigurePlan after researching material/images: the Core Hook, research figure type, regions, nodes, edges, constraints, and a unified style scheme. Think the whole figure through before creating elements; the plan is echoed to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        core_hook: {
          type: 'string',
          description:
            "The deck's narrative anchor (one sentence, with tension, ideally containing a number or counter-intuitive contrast)",
        },
        style: {
          type: 'string',
          description:
            'Unified design system: primary/secondary colors, font tone, content margins, card/corner style (e.g. "dark blue primary + gold accents, data-dashboard look"); every page follows it',
        },
        pages: {
          type: 'array',
          description: 'Per-page plan',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Page title' },
              type: { type: 'string', description: 'cover|content|data|closing' },
              brief: {
                type: 'string',
                description:
                  'Page content description (use real data/facts; say what goes in each region)',
              },
              layout: {
                type: 'string',
                description:
                  'Layout (e.g. three_column_cards/hero_big_number/two_column/timeline/left_text_right_image); content pages must not repeat',
              },
              image_queries: {
                type: 'array',
                items: { type: 'string' },
                description:
                  "English image-search keywords for this page's image slots (one per slot; [] for no images)",
              },
            },
            required: ['title', 'brief', 'layout'],
          },
        },
      },
      required: ['core_hook', 'style', 'pages'],
    },
  },
  {
    name: 'regenerate_slide',
    description:
      '[Redo/redesign an existing page] Regenerates the page from your brief and replaces it in place (other pages untouched, undoable).' +
      ' Use when the user says "redo this page / redesign it / try another layout / make it prettier"; don\'t dismantle the page element by element with native tools.' +
      " Flow: first read_slide to get the page's current content, then check neighboring pages / get_deck_context to grasp the deck's style;" +
      ' write a detailed brief — what to keep (copy real text/data into the brief verbatim), what to change, and the target layout; the deck style is applied automatically.' +
      ' If the page needs images, image_search first and pass real URLs in image_urls.' +
      ' If generation fails, it is usually a temporary error: do NOT loop retrying — make the concrete changes in place with execute_slide_script instead (or tell the user to try again in a few minutes).',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page to redo (0-based)' },
        brief: {
          type: 'string',
          description:
            'Content and layout brief for the new page: what goes in each region (copy the real copy/data to keep into the brief), and the layout to use (e.g. three_column_cards/hero_big_number/two_column/timeline).',
        },
        title: { type: 'string', description: 'Page title' },
        layout: { type: 'string', description: 'Layout intent name (optional)' },
        image_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Real http(s) image URLs for this page (image_search first; [] for none)',
        },
        dataSource: {
          type: 'string',
          enum: ['user', 'document', 'search', 'sample'],
          description:
            "Required when the brief carries specific figures (%, money, magnitudes): where they came from — 'user'/'document'/'search' (run web_search first)/'sample' (disclose to the user)",
        },
      },
      required: ['slideIndex', 'brief'],
    },
  },
  {
    name: 'delete_slide',
    description:
      "Delete an entire page (not allowed when only one page remains). After deletion, later pages' slideIndex shifts down.",
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
      },
      required: ['slideIndex'],
    },
  },
  {
    name: 'generate_deck',
    description:
      '[First choice for creating a whole new deck — self-driven pipeline: auto image search, page-by-page generation with live display, no missing pages]' +
      ' Recommended usage (especially with many pages): pass only topic + approx_pages (+ optional style/context); the system plans the outline internally (auto-batched beyond 12 pages), **auto-searches images** (no advance image_search — the system searches from the planned image_queries keywords internally and fills real URLs back before writing HTML), writes HTML page by page, and lands pages onto the canvas one by one.' +
      ' You don\'t hand-write dozens of pages, and neither "only page 1 got generated" nor "arguments were truncated" can happen — the page count is guaranteed by the system loop.' +
      ' (If you already know each page you may pass core_hook+style+pages directly; pages[].image_queries takes English image-search keywords, searched internally; if you already know real http(s) URLs pass them directly — the system respects existing URLs and does not re-search.)' +
      ' To add a few pages to an existing deck, pass pages (briefs for just the new pages) + insert_mode:"append".',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            "[Recommended] The deck's topic/requirements description (with topic you don't hand-write pages; the system plans internally)",
        },
        approx_pages: {
          type: 'integer',
          description: 'Expected page count (used together with topic)',
        },
        context: {
          type: 'string',
          description:
            'Optional: real material/data/questionnaire answers from web_search, so internal planning uses real content',
        },
        core_hook: {
          type: 'string',
          description:
            'Optional: a narrative anchor you already decided (recommended alongside pages)',
        },
        style: {
          type: 'string',
          description:
            'Unified design system: primary/secondary colors, fonts, content margins, card corners (required with pages; optional as a style hint with topic)',
        },
        pages: {
          type: 'array',
          description:
            'Optional: pass directly when you already know each page (as many pages generated as planned). With many pages prefer topic and internal planning, to avoid over-long truncated arguments',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Page title' },
              type: { type: 'string', description: 'cover|content|data|closing' },
              brief: {
                type: 'string',
                description: 'Page content description (use real data/facts)',
              },
              layout: { type: 'string', description: 'Layout (content pages must not repeat)' },
              image_queries: {
                type: 'array',
                items: { type: 'string' },
                description:
                  "English image-search keywords for this page's image slots (the system searches internally and fills real URLs back); if you already know real http(s) URLs pass them directly (respected, not re-searched); [] for no images",
              },
            },
            required: ['title', 'brief', 'layout'],
          },
        },
        insert_mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description:
            'replace (default, new whole deck) = replace everything; append = append at the end',
        },
        style_template: {
          type: 'string',
          description:
            "Optional: name of a saved style template (from list_style_templates); when passed, Step 0 is skipped and the template's styleSkill is used directly, no style regeneration",
        },
        dataSource: {
          type: 'string',
          enum: ['user', 'document', 'search', 'sample'],
          description:
            "Required when topic/context/briefs carry specific figures (%, money, magnitudes): where they came from — 'user'/'document'/'search' (run web_search first)/'sample' (disclose to the user)",
        },
      },
    },
  },
  {
    name: 'save_style_template',
    description:
      '[Save the current deck\'s style as a reusable template] Saves the current presentation\'s Style Skill (visual style guide) under the given name; next time you generate a deck, pass the style_template argument to reuse it directly and skip style generation. Call when the user says "save this style" / "save as template".',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Template name (short, e.g. "minimal-blue" or "tech-dark")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_style_templates',
    description:
      'List all saved style templates (name + topic + createdAt). When the user says "use last time\'s style" or "use some template", call this first to see what exists, then pass the target template name to generate_deck\'s style_template argument.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_slide',
    description:
      "Create a new page by cloning the layout (including background) of page sourceIndex, inserted right after it (new page number = sourceIndex+1; pages after it shift back); clearText=true (default) clears text to get a layout-preserving blank page. When building page by page, use the CURRENT LAST page as sourceIndex so new pages append at the end. The return value gives the new page's slideIndex; subsequent content fills MUST use that returned page number.",
    inputSchema: {
      type: 'object',
      properties: {
        sourceIndex: {
          type: 'integer',
          description: 'Page to use as the layout template (0-based)',
        },
        clearText: {
          type: 'boolean',
          description: "Default true; false keeps the template page's text",
        },
      },
      required: ['sourceIndex'],
    },
  },
  {
    name: 'add_text_box',
    description: 'Create a new text box on a page (pixel coordinates). Returns the new element id.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        paragraphs: { $ref: '#/definitions/paragraphs' },
      },
      required: ['slideIndex', 'x', 'y', 'w', 'h', 'paragraphs'],
      definitions: PARAGRAPHS_DEF,
    },
  },
  {
    name: 'add_shape',
    description:
      'Create a new shape on a page (optionally with solid fill and text). kind uses OOXML preset geometry names, common ones: rect/roundRect/ellipse/triangle/diamond/rightArrow/leftArrow/chevron/star5/heart/pie/donut/cloud/wedgeRoundRectCallout. Returns the new element id.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        kind: {
          type: 'string',
          description:
            'OOXML preset geometry name, e.g. rect / roundRect / ellipse / rightArrow / star5',
        },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        fillColor: { type: 'string', description: '#RRGGBB' },
        paragraphs: { $ref: '#/definitions/paragraphs' },
      },
      required: ['slideIndex', 'kind', 'x', 'y', 'w', 'h'],
      definitions: PARAGRAPHS_DEF,
    },
  },
  {
    name: 'add_connector',
    description:
      'Draw a connector between two existing elements and bind its endpoints to them (it follows when either element is later moved). kind: straight (default) / elbow / curved. Optional color and width. Returns the new connector element id.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        fromId: { type: 'string', description: 'Source element id (from the outline/read_slide)' },
        toId: { type: 'string', description: 'Target element id' },
        kind: { type: 'string', enum: ['straight', 'elbow', 'curved'] },
        color: { type: 'string', description: '#RRGGBB stroke color' },
        widthPt: { type: 'number', description: 'Stroke width in points (default 1.5)' },
      },
      required: ['slideIndex', 'fromId', 'toId'],
    },
  },
  {
    name: 'set_slide_size',
    description:
      'Set the slide canvas size (applies to the whole deck; existing elements are rescaled proportionally). Use millimeters. Common research-figure sizes: single-column 90x90, double-column 190x120, A4-landscape 297x210, slide-16:9 338.7x190.5.',
    inputSchema: {
      type: 'object',
      properties: {
        widthMm: { type: 'number', description: 'Canvas width in millimeters' },
        heightMm: { type: 'number', description: 'Canvas height in millimeters' },
      },
      required: ['widthMm', 'heightMm'],
    },
  },
  {
    name: 'create_input_core_output',
    description:
      'Research figure recipe: lay out an Input → Core → Output framework on one page with bound connectors and an optional bottom feedback loop. Node kinds come from the research registry (data-source/input-node/process-node/model-module/mechanism-module/output-node/evidence-node). Zones are sized and spaced deterministically; you do NOT compute coordinates. Use this instead of hand-placing shapes for framework figures.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        inputNodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              component: { type: 'string' },
              title: { type: 'string' },
              subtitle: { type: 'string' },
            },
            required: ['component', 'title'],
          },
        },
        coreNodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              component: { type: 'string' },
              title: { type: 'string' },
              subtitle: { type: 'string' },
            },
            required: ['component', 'title'],
          },
        },
        outputNodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              component: { type: 'string' },
              title: { type: 'string' },
              subtitle: { type: 'string' },
            },
            required: ['component', 'title'],
          },
        },
        feedback: {
          type: 'boolean',
          description: 'Add a bottom feedback loop (output back to core)',
        },
        dataSource: {
          type: 'string',
          enum: ['user', 'document', 'search', 'sample'],
          description:
            "Required when node labels carry specific figures: 'user'/'document'/'search' (run web_search first)/'sample' (disclose to the user)",
        },
        themeId: {
          type: 'string',
          description:
            'Optional preset palette id: academic-blue (default) / academic-green / wine-red / purple-gray / neutral-gray / black-accent / ai-cyan / warm-humanities / nature-light / dark-academic',
        },
      },
      required: ['slideIndex', 'inputNodes', 'coreNodes', 'outputNodes'],
    },
  },
  {
    name: 'create_horizontal_pipeline',
    description:
      'Research figure recipe: lay out an ordered left-to-right pipeline of registered research components with equal gaps, a shared baseline, and bound main-flow connectors. The Recipe owns coordinates; do not compute them.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              component: { type: 'string' },
              title: { type: 'string' },
              subtitle: { type: 'string' },
            },
            required: ['component', 'title'],
          },
          description: 'Ordered pipeline nodes, from left to right',
        },
        dataSource: {
          type: 'string',
          enum: ['user', 'document', 'search', 'sample'],
          description:
            "Required when node labels carry specific figures: 'user'/'document'/'search' (run web_search first)/'sample' (disclose to the user)",
        },
        themeId: {
          type: 'string',
          description: 'Optional preset palette id; defaults to academic-blue',
        },
      },
      required: ['slideIndex', 'nodes'],
    },
  },
  {
    name: 'create_research_figure',
    description:
      "[Research Figure Mode] End-to-end orchestrated creation from a thesis: runs the Semantic Planner (semantics only), compresses visible text, measures real sizes, generates + ranks composition candidates (model plan vs deterministic priors by autonomy), solves legal geometry, routes native connectors, and audits before writing. This is the DEFAULT AND ONLY tool for a NEW figure. plan_research_figure + create_input_core_output/create_horizontal_pipeline are legacy tools reserved for executing an already-validated FigurePlan — never use them for a new figure. Don't pass pixel coordinates.",
    inputSchema: {
      type: 'object',
      properties: {
        thesis: {
          type: 'string',
          description: 'The research figure request (what the figure must communicate)',
        },
        notes: {
          type: 'string',
          description: 'Optional researched material: key nodes, data, edge labels',
        },
        contract: {
          type: 'object',
          description:
            'Structured Figure Contract - pass whenever the user supplies material (paper/notes/data). Fields: centralClaim, figureFamily, domain, venue, audience, output{context,finalWidthMm,finalHeightMm,aspectRatio}, evidenceMustShow[{id,description,source}], forbiddenClaims[], visibleTextPolicy{allowed,required,forbidden,language}, provenance[{claim,source,locator}]. NEVER invent evidence or provenance - omit fields you cannot source.',
          properties: {
            centralClaim: { type: 'string' },
            figureFamily: {
              type: 'string',
              enum: [
                'framework',
                'architecture',
                'pipeline',
                'mechanism',
                'causal-model',
                'hierarchy',
                'network',
                'timeline',
                'matrix',
                'comparison',
                'freeform',
              ],
            },
            domain: {
              type: 'string',
              enum: [
                'general',
                'cs-ml',
                'materials-chemistry',
                'biomed',
                'engineering',
                'social-science',
              ],
            },
            venue: { type: 'string' },
            audience: { type: 'string' },
            output: {
              type: 'object',
              properties: {
                context: {
                  type: 'string',
                  enum: [
                    'presentation',
                    'paper-single-column',
                    'paper-double-column',
                    'full-page-paper',
                    'thesis',
                    'poster',
                    'web',
                  ],
                },
                finalWidthMm: { type: 'number' },
                finalHeightMm: { type: 'number' },
                aspectRatio: { type: 'number' },
              },
            },
            evidenceMustShow: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  description: { type: 'string' },
                  source: {
                    type: 'string',
                    enum: ['user', 'document', 'search', 'dataset', 'sample', 'derived'],
                  },
                },
                required: ['id'],
              },
            },
            evidenceOptional: { type: 'array', items: { type: 'object' } },
            forbiddenClaims: { type: 'array', items: { type: 'string' } },
            visibleTextPolicy: {
              type: 'object',
              properties: {
                allowed: { type: 'array', items: { type: 'string' } },
                required: { type: 'array', items: { type: 'string' } },
                forbidden: { type: 'array', items: { type: 'string' } },
                language: { type: 'string', enum: ['zh', 'en', 'mixed'] },
              },
            },
            provenance: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  claim: { type: 'string' },
                  source: {
                    type: 'string',
                    enum: ['user', 'document', 'search', 'dataset', 'sample', 'derived'],
                  },
                  locator: { type: 'string' },
                },
                required: ['claim', 'source'],
              },
            },
          },
        },
        themeId: { type: 'string', description: 'Optional theme id (default academic-blue)' },
        domain: {
          type: 'string',
          enum: [
            'general',
            'cs-ml',
            'materials-chemistry',
            'biomed',
            'engineering',
            'social-science',
          ],
          description:
            'Scientific domain: selects the domain visual language (primitives, connector semantics)',
        },
        figureFamily: {
          type: 'string',
          enum: [
            'framework',
            'architecture',
            'pipeline',
            'mechanism',
            'causal-model',
            'hierarchy',
            'network',
            'timeline',
            'matrix',
            'comparison',
            'freeform',
          ],
          description: 'Figure family when the user names one',
        },
        venue: {
          type: 'string',
          description:
            'Target venue (e.g. "Nature", "CVPR", "thesis") — raises the quality threshold',
        },
        outputContext: {
          type: 'string',
          enum: [
            'presentation',
            'paper-single-column',
            'paper-double-column',
            'full-page-paper',
            'thesis',
            'poster',
            'web',
          ],
          description: 'Final output context — drives publication-size font scaling',
        },
        capability: {
          type: 'object',
          description: 'Optional calibration override used by deterministic tests',
          properties: {
            calibration: {
              type: 'object',
              properties: {
                spatialPlanning: { type: 'string', enum: ['unknown', 'weak', 'medium', 'strong'] },
                jsonReliability: { type: 'string', enum: ['low', 'medium', 'high'] },
              },
            },
          },
        },
      },
      required: ['thesis'],
    },
  },
  {
    name: 'add_chart',
    description:
      "Insert a chart on a page (native pptx chart, still editable in PowerPoint). categories are the x-axis categories; series is each series' name and values (length must match categories). Omit x/y/w/h to center it. dataSource declares where the numbers came from and is enforced — never present invented numbers as real data.",
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        kind: { type: 'string', enum: ['bar', 'barStacked', 'line', 'area', 'pie', 'doughnut'] },
        title: { type: 'string', description: 'Chart title (optional)' },
        categories: { type: 'array', items: { type: 'string' } },
        series: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'number' } },
            },
            required: ['name', 'values'],
          },
        },
        dataSource: {
          type: 'string',
          enum: ['user', 'document', 'search', 'sample'],
          description:
            "Provenance of the values: 'user' = supplied by the user/attachments, 'document' = read from this deck, 'search' = from web_search results in this conversation (run it first), 'sample' = illustrative placeholders you must disclose to the user",
        },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['slideIndex', 'kind', 'categories', 'series', 'dataSource'],
    },
  },
  {
    name: 'add_smartart',
    description:
      'Insert a SmartArt-style diagram (shape composition) on a page: list=vertical list, process=process arrows, cycle=cycle, hierarchy=org structure, pyramid=stacked pyramid levels, matrix=2x2 quadrant grid, venn=overlapping circles. items are the node texts. Omit x/y/w/h to center it.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        layout: {
          type: 'string',
          enum: ['list', 'process', 'cycle', 'hierarchy', 'pyramid', 'matrix', 'venn'],
        },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Node texts (2-8 recommended)',
        },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['slideIndex', 'layout', 'items'],
    },
  },
  {
    name: 'add_table',
    description:
      'Insert a native pptx table on a page (with built-in styling, still editable in PowerPoint). cells gives text row by row (optional; ' +
      'missing rows/columns stay empty). Omit x/y/w/h to center it.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        rows: { type: 'integer', description: 'Row count (including header)' },
        cols: { type: 'integer', description: 'Column count' },
        cells: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Cell texts, row by row, e.g. [["Name","Qty"],["A","1"]]',
        },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['slideIndex', 'rows', 'cols'],
    },
  },
  {
    name: 'edit_table_cell',
    description:
      "Replace one table cell's text entirely. The table element id comes from the outline/read_slide (type=table); row/col are 0-based.",
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Table element id' },
        row: { type: 'integer', description: 'Row number (0-based)' },
        col: { type: 'integer', description: 'Column number (0-based)' },
        paragraphs: { $ref: '#/definitions/paragraphs' },
      },
      required: ['slideIndex', 'sourceId', 'row', 'col', 'paragraphs'],
      definitions: PARAGRAPHS_DEF,
    },
  },
  {
    name: 'edit_table_structure',
    description:
      'Add/remove table rows/columns: kind=insert-row/delete-row/insert-col/delete-col; index is the row/column number (0-based), insert defaults to after it, before=true inserts before it.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Table element id' },
        kind: { type: 'string', enum: ['insert-row', 'delete-row', 'insert-col', 'delete-col'] },
        index: { type: 'integer', description: 'Row/column number (0-based)' },
        before: { type: 'boolean', description: 'For insert, set true to insert before index' },
      },
      required: ['slideIndex', 'sourceId', 'kind', 'index'],
    },
  },
  {
    name: 'edit_table_style',
    description:
      'Modify table styling: apply a preset (styleName) or individually change header row/banding/shading/borders. styleName options: none/lightGrid/zebraBlue/zebraGray/headerDarkBlue/headerOrange/noBorder/fullBorder.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Table element id' },
        styleName: {
          type: 'string',
          description: 'Preset style name (see description), highest priority',
        },
        firstRow: { type: 'boolean', description: 'Enable header row (first-row emphasis)' },
        bandRow: { type: 'boolean', description: 'Enable banded rows' },
        shadingColor: {
          type: 'string',
          description: 'Shading color #RRGGBB, "none" clears shading',
        },
        borderColor: { type: 'string', description: 'Border color #RRGGBB' },
        borderWidthPt: { type: 'number', description: 'Border width (pt)' },
        borderPreset: {
          type: 'string',
          enum: ['all', 'none'],
          description: '"all" = full borders, "none" = clear borders',
        },
      },
      required: ['slideIndex', 'sourceId'],
    },
  },
  {
    name: 'edit_chart',
    description:
      'Modify a chart (including charts from imported files; first edit converts it to editable automatically): change type/data/colors/chart elements. kind options: bar/barStacked/line/area/pie/doughnut. colorScheme: default/colorful/colorful2/mono-accent1..6 (theme-derived); legacy keys blue/warm/cool/mono still work.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string', description: 'Chart element id (type=chart)' },
        kind: {
          type: 'string',
          enum: ['bar', 'barStacked', 'line', 'area', 'pie', 'doughnut'],
          description: 'Change chart type (optional)',
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'X-axis/category labels (optional)',
        },
        series: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'number' } },
            },
            required: ['name', 'values'],
          },
          description: 'Data series (optional)',
        },
        dataSource: {
          type: 'string',
          enum: ['user', 'document', 'search', 'sample'],
          description:
            "Required when passing series: provenance of the values ('user'/'document'/'search'/'sample'; 'search' needs a prior web_search, 'sample' must be disclosed to the user)",
        },
        colorScheme: {
          type: 'string',
          description: 'Color scheme (optional): default/colorful/colorful2/mono-accent1..6',
        },
        title: { type: 'string', description: 'Chart title (optional)' },
        legendPos: {
          type: 'string',
          enum: ['b', 't', 'r', 'l', 'none'],
          description: 'Legend position (optional)',
        },
        dataLabels: { type: 'boolean', description: 'Data labels toggle (optional)' },
        gridlines: { type: 'boolean', description: 'Value-axis gridlines toggle (optional)' },
        switchRowCol: {
          type: 'boolean',
          description: 'Switch rows/columns: categories ↔ series (optional)',
        },
      },
      required: ['slideIndex', 'sourceId'],
    },
  },
  {
    name: 'set_slide_background',
    description: 'Set a solid page background color. slideIndex=-1 applies to all pages.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based); -1 = all pages' },
        color: { type: 'string', description: '#RRGGBB' },
      },
      required: ['slideIndex', 'color'],
    },
  },
  {
    name: 'apply_ops',
    description:
      '[Advanced batch surface] Apply a list of canonical edit ops as ONE transaction — atomic by default: any failure rolls everything back, nothing is half-applied. Set dry_run:true to validate the plan without touching the deck (rehearse risky batches). Use for multi-page or many-element batches (retitle every page, deck-wide transitions, bulk restyle); for one-page layout math prefer execute_slide_script, for ordinary single edits prefer the dedicated tools.\n' +
      'Addressing: every op takes target:{slide, el?} — slide = 0-based index or durable "s_<n>"; el = an element id from the outline/read_slide (e_* ids are durable). Group children: put the child id in target.el and add group:"<group id>".\n' +
      'Units are document-space EMU. read_slide reports px and its exact "1 px = N EMU" factor — convert with that N (9525 only on a standard 16:9 deck; other page sizes differ). Font sizes are pt.\n' +
      'Full vocabulary (the same executor every editing surface uses):\n' +
      opVocabulary() +
      '\nCommon signatures: setText {paragraphs:[{runs:[{text,bold?,italic?,fontSize?,color?}],align?}]} · setFont {font:{fontFamily?,fontSizePt?,bold?,…}} · setFill {fill:"#RRGGBB"|"none"} · setStroke {stroke:{color,widthEmu}|null} · setTransform {box:{x,y,cx,cy},rotDeg?} · addElement {kind:"textbox"|preset,offset,paragraphs?} · setTableCell {row,col,paragraphs} · moveSlide {to} · findReplace {find,replace}.\n' +
      "For any other op, send your best guess: a failing op's error returns its exact one-line signature, and dry_run rehearses the whole batch without touching the deck. An unknown op name returns the full vocabulary.",
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: { type: 'object' },
          description: 'The op list, applied in order as one transaction (at most 50)',
        },
        dry_run: { type: 'boolean', description: 'Validate the plan only; the deck is untouched' },
        isolation: {
          type: 'string',
          enum: ['atomic', 'per_op'],
          description: 'atomic (default): all-or-nothing. per_op: independent ops, failures skip.',
        },
      },
      required: ['ops'],
    },
  },
  {
    name: 'set_speaker_notes',
    description:
      'Overwrite the speaker notes of a page. Notes are shown in presenter view and saved into the .pptx notesSlide part; they do not affect canvas content. text replaces the page\'s current notes entirely; pass text:"" to clear them. Call when the user asks to add/update/remove notes for a page.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        text: {
          type: 'string',
          description:
            'Full speaker notes text; paragraphs separated by newlines. Empty string clears the notes.',
        },
      },
      required: ['slideIndex', 'text'],
    },
  },
  {
    name: 'delete_element',
    description: 'Delete one element from a page.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer' },
        sourceId: { type: 'string' },
      },
      required: ['slideIndex', 'sourceId'],
    },
  },
  {
    name: 'ungroup_element',
    description:
      'Ungroup a group element: promote its direct children to top-level page elements (positions/sizes preserved). Use when group members must be edited/deleted independently (e.g. elements nested in a sub-group, or deleting a single member). Note: ungrouping rewrites the page, so all element ids on it change — use the fresh ids returned in the result.',
    inputSchema: {
      type: 'object',
      properties: {
        slideIndex: { type: 'integer', description: 'Page number (0-based)' },
        sourceId: { type: 'string', description: 'Group element id' },
      },
      required: ['slideIndex', 'sourceId'],
    },
  },
]

/** Collect readable text of nodes (including nested group children); returns a list of [sourceId, type, text] */
/** Find one node by id in the node tree (including groups). */
function findNodeById(nodes: RenderNode[], id: string): RenderNode | undefined {
  for (const n of nodes) {
    if (n.sourceId === id || n.durableId === id) return n
    if (n.type === 'group') {
      const hit = findNodeById(n.children, id)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * Editable context of an element: a top-level node, or a direct child of a top-level group
 * (with groupId + the group's absolute origin for abs↔group-local px conversion — child render
 * boxes are group-local, matching the in-group edit IPCs). Deeper nesting returns {nested:true}:
 * the main process patches one level only, so those stay read-only until ungrouped.
 */
type EditTarget =
  { node: RenderNode; groupId?: string; groupOrigin?: { x: number; y: number } } | { nested: true }
function resolveEditTarget(slide: RenderSlide, sourceId: string): EditTarget | null {
  const matches = (n: RenderNode) => n.sourceId === sourceId || n.durableId === sourceId
  for (const n of slide.nodes) {
    if (matches(n)) return { node: n }
    if (n.type === 'group') {
      const g = n as GroupRenderNode
      const child = g.children.find(matches)
      if (child)
        return {
          node: child,
          groupId: n.sourceId,
          groupOrigin: { x: Math.round(n.box.x), y: Math.round(n.box.y) },
        }
      if (findNodeById(g.children, sourceId)) return { nested: true }
    }
  }
  return null
}

/** Editable element ids of a slide (locked layout decorations excluded), with short text hints. */
function availableIdList(slide: RenderSlide, withText = false): string {
  return collectNodeInfos(slide.nodes)
    .filter((n) => !n.locked)
    .map((n) => (withText && n.text?.trim() ? `${n.id} ("${preview(n.text, 12)}")` : n.id))
    .join(', ')
}

/**
 * Shared not-found / nested-in-subgroup error text for element-targeting tools. Guided: the
 * not-found branch lists the ids that DO exist — models self-correct from the list, but
 * blind-retry a bare "not found".
 */
function targetError(
  target: EditTarget | null,
  sourceId: string,
  pageNo: number,
  slide?: RenderSlide,
): string | null {
  if (!target) {
    const avail = slide ? ` Elements on this page: [${availableIdList(slide)}].` : ''
    return `Element ${sourceId} not found on page ${pageNo}.${avail} (e_* ids are durable across edits/saves; call read_slide when in doubt)`
  }
  if ('nested' in target)
    return `Element ${sourceId} is nested inside a sub-group; call ungroup_element on the outer group first, or edit the sub-group as a whole`
  return null
}

/**
 * Restore a render node's current text into EditParagraph[] (aggregate runs by line, keeping
 * each run's existing formatting). Used by set_element_style: change formatting while keeping
 * the text. fontSize is converted back from px to pt.
 */
function nodeToParagraphs(node: ShapeRenderNode): EditParagraph[] {
  const lines = node.text?.lines ?? []
  return lines.map((line) => ({
    runs: line.runs.map((r) => ({
      text: r.text,
      ...(r.bold ? { bold: true } : {}),
      ...(r.italic ? { italic: true } : {}),
      ...(r.underline ? { underline: true } : {}),
      ...(r.fontSizePx ? { fontSize: Math.round((r.fontSizePx * 72) / 96) } : {}),
      ...(r.fontFamily ? { fontFamily: r.fontFamily } : {}),
      ...(r.color ? { color: r.color } : {}),
    })),
  }))
}

/**
 * Merge style-override fields into existing paragraphs: bold/italic/font size/color/font are
 * overridden per run, align is set on the paragraph, fields not passed stay unchanged. Shared
 * by the set_element_style tool and execute_slide_script's setStyle dispatch.
 */
function mergeStyleIntoParagraphs(cur: EditParagraph[], ov: SlideStylePatch): EditParagraph[] {
  return cur.map((p) => ({
    runs: p.runs.map((r) => ({
      text: r.text,
      bold: ov.bold ?? r.bold,
      italic: ov.italic ?? r.italic,
      underline: ov.underline ?? r.underline,
      fontSize: typeof ov.fontSize === 'number' ? ov.fontSize : r.fontSize,
      fontFamily: ov.fontFamily ?? r.fontFamily,
      color: ov.color ?? r.color,
    })),
    align: ov.align ?? p.align,
  }))
}

/** Element info shared by outline/read_slide/edit scripts (includes absolute geometry; locked = layout decoration, read-only). */
type NodeInfo = LayoutScriptElement

function nodeText(n: RenderNode): string {
  if (n.type === 'shape' || n.type === 'text') {
    return ((n as ShapeRenderNode).text?.lines ?? [])
      .map((line) => line.runs.map((r) => r.text).join(''))
      .join('\n')
  }
  if (n.type === 'table') {
    // Tables join cell text row by row (tab-separated) so the AI can read table content
    const byRow = new Map<number, string[]>()
    for (const c of n.cells) {
      const t = (c.text?.lines ?? []).map((l) => l.runs.map((r) => r.text).join('')).join(' ')
      const row = byRow.get(c.y) ?? []
      row.push(t)
      byRow.set(c.y, row)
    }
    return [...byRow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, r]) => r.join('\t'))
      .join('\n')
  }
  return ''
}

/** Max font size of the text (pt, converted back from px); returns undefined when there is no text. */
function nodeMaxFontPt(n: RenderNode): number | undefined {
  if (n.type !== 'shape' && n.type !== 'text') return undefined
  let maxPx = 0
  for (const line of (n as ShapeRenderNode).text?.lines ?? []) {
    for (const r of line.runs) if (r.fontSizePx > maxPx) maxPx = r.fontSizePx
  }
  return maxPx > 0 ? Math.round((maxPx * 72) / 96) : undefined
}

/** Normalize a render color to #RRGGBB (strips alpha); undefined when not a hex color. */
function hex6(color: string | undefined): string | undefined {
  if (!color) return undefined
  const m = /^#([0-9a-fA-F]{6})/.exec(color.trim())
  return m ? `#${m[1].toUpperCase()}` : undefined
}

/** Dominant text color = the run color covering the most characters (bullets excluded). */
function dominantTextColor(n: RenderNode): string | undefined {
  if (n.type !== 'shape' && n.type !== 'text') return undefined
  const weight = new Map<string, number>()
  for (const line of (n as ShapeRenderNode).text?.lines ?? []) {
    for (const r of line.runs) {
      if (r.isBullet) continue
      const c = hex6(r.color)
      if (c) weight.set(c, (weight.get(c) ?? 0) + r.text.length)
    }
  }
  let best: string | undefined
  let max = 0
  for (const [c, w] of weight) {
    if (w > max) {
      best = c
      max = w
    }
  }
  return best
}

/** Readable colors of a node (solid fill / dominant text color / stroke); pictures only expose stroke. */
function nodeColors(n: RenderNode): Pick<NodeInfo, 'fill' | 'textColor' | 'strokeColor'> {
  const out: Pick<NodeInfo, 'fill' | 'textColor' | 'strokeColor'> = {}
  if (n.type === 'shape' || n.type === 'text') {
    const s = n as ShapeRenderNode
    if (s.fill.kind === 'solid') {
      const c = hex6(s.fill.color)
      if (c) out.fill = c
    }
    const stroke = hex6(s.stroke?.color)
    if (stroke) out.strokeColor = stroke
    const text = dominantTextColor(n)
    if (text) out.textColor = text
  } else if (n.type === 'picture') {
    const stroke = hex6((n as PictureRenderNode).stroke?.color)
    if (stroke) out.strokeColor = stroke
  }
  return out
}

/**
 * Collect node info (including nested group children). A child's box is in group-local
 * coordinates (ext/chExt scaling already baked into geometry at build time); here we add the
 * group offset to convert to absolute coordinates and set the inGroup flag. Direct children of a
 * top-level group also carry groupId (editable via the in-group pipeline); deeper nesting stays
 * read-only (the main process patches one level only).
 */
function collectNodeInfos(
  nodes: RenderNode[],
  ox = 0,
  oy = 0,
  parent?: { id: string; topLevel: boolean },
): NodeInfo[] {
  const out: NodeInfo[] = []
  for (const n of nodes) {
    const b = n.box
    const abs = {
      x: Math.round(ox + b.x),
      y: Math.round(oy + b.y),
      w: Math.round(b.w),
      h: Math.round(b.h),
    }
    const base: NodeInfo = {
      // Durable id when the element's bytes carry one — survives regenerate/
      // ungroup/save, so the AI can keep addressing across turns
      id: n.durableId ?? n.sourceId,
      type: n.type,
      text: nodeText(n),
      ...abs,
      rotation: b.rotationDeg,
      ...(parent ? { inGroup: true } : {}),
      ...(parent?.topLevel ? { groupId: parent.id } : {}),
      ...(n.decoration ? { locked: true } : {}),
      ...nodeColors(n),
    }
    const fontPt = nodeMaxFontPt(n)
    if (fontPt !== undefined) base.fontSizePt = fontPt
    out.push(base)
    if (n.type === 'group') {
      const g = n as GroupRenderNode
      out.push(
        ...collectNodeInfos(g.children, abs.x, abs.y, {
          id: n.durableId ?? n.sourceId,
          topLevel: !parent,
        }),
      )
    }
  }
  return out
}

function preview(text: string, max = 50): string {
  const flat = text.replace(/\n/g, ' / ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function buildDeckOutline(slides: RenderSlide[], current: number, selectedIds: string[]): string {
  const canvas = slides[0] ? `Canvas ${slides[0].widthPx}×${slides[0].heightPx}px.` : ''
  const lines: string[] = [
    `The presentation has ${slides.length} pages; page ${current + 1} is currently shown. ${canvas}`,
    `(Page order is the current actual order and may differ from generation time or earlier conversation; the user's "page N" refers to this outline)`,
  ]
  if (selectedIds.length > 0) {
    const currentSlide = slides[current]
    lines.push(
      `User selected ${selectedIds.length} element(s) on page ${current + 1} — element-scoped requests (move/restyle/edit) target these unless the user says otherwise. Full details:`,
    )
    const infos = currentSlide ? collectNodeInfos(currentSlide.nodes) : []
    for (const id of selectedIds) {
      const node = currentSlide ? findNodeById(currentSlide.nodes, id) : undefined
      const key = node?.durableId ?? node?.sourceId ?? id
      const info = infos.find((n) => n.id === key)
      if (!info || !node) {
        lines.push(`  - ${id} (details unavailable)`)
        continue
      }
      const bits = [`${info.id}`, info.type, `pos(${info.x},${info.y}) size(${info.w}×${info.h})`]
      if (info.text) bits.push(`text "${preview(info.text, 40)}"`)
      if ((info as { fill?: string }).fill) bits.push(`fill ${(info as { fill: string }).fill}`)
      if ((info as { strokeColor?: string }).strokeColor)
        bits.push(`stroke ${(info as { strokeColor: string }).strokeColor}`)
      if (info.fontSizePt) bits.push(`${info.fontSizePt}pt`)
      if ((info as { groupId?: string }).groupId)
        bits.push(`in group ${(info as { groupId: string }).groupId}`)
      lines.push(`  - ${bits.join(' | ')}`)
    }
  }
  slides.forEach((slide, i) => {
    lines.push(`Page ${i + 1} (slideIndex=${i}):`)
    const infos = collectNodeInfos(slide.nodes)
    const fillCount = new Map<string, number>()
    for (const n of infos) {
      if (n.fill) fillCount.set(n.fill, (fillCount.get(n.fill) ?? 0) + 1)
    }
    const mainFills = [...fillCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, count]) => (count > 1 ? `${c}×${count}` : c))
    if (mainFills.length > 0) lines.push(`  main fills: ${mainFills.join(' ')}`)
    for (const n of infos) {
      lines.push(`  - ${n.id} | ${n.type}${n.text ? ` | "${preview(n.text)}"` : ''}`)
    }
  })
  lines.push('(Use read_slide to see element positions/sizes/colors)')
  return lines.join('\n')
}

/**
 * Element inventory of one slide as read_slide reports it (ids + geometry + colors + text).
 * Shared by the read_slide tool and the post-generation layout QC pass (slide-qc.ts), so the
 * QC model maps screenshot pixels back to the same ids/coordinates the edit tools accept.
 */
export function formatSlideDump(slide: RenderSlide): string {
  const infos = collectNodeInfos(slide.nodes)
  const parts = infos.map((n) => {
    const flags = [
      n.groupId
        ? `in group ${n.groupId} (directly editable)`
        : n.inGroup
          ? 'nested in a sub-group (read-only; ungroup_element the outer group to edit)'
          : '',
      n.locked ? 'layout decoration (read-only)' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const rot = n.rotation ? ` rotation ${Math.round(n.rotation)}°` : ''
    const font = n.fontSizePt ? ` font ${n.fontSizePt}pt` : ''
    const colors = [
      n.fill ? `fill${n.fill}` : '',
      n.textColor ? `text${n.textColor}` : '',
      n.strokeColor ? `stroke${n.strokeColor}` : '',
    ]
      .filter(Boolean)
      .join(' ')
    const head = `${n.id} | ${n.type}${flags ? ` | ${flags}` : ''} | pos(${n.x},${n.y}) size ${n.w}×${n.h}${rot}${font}${colors ? ` | ${colors}` : ''}`
    return n.text ? `${head}\n${n.text}` : `${head} | (no text)`
  })
  const colorlessTypes = [
    ...new Set(
      infos
        .filter((n) => !n.fill && !n.textColor && !n.strokeColor)
        .filter((n) => n.type === 'picture' || n.type === 'chart')
        .map((n) => n.type),
    ),
  ]
  const colorNote = colorlessTypes.length
    ? `\n(${colorlessTypes.join('/')} colors not available)`
    : ''
  // Report the real px→EMU factor: render px carry the viewport scale, so ×9525 only
  // holds for decks whose baseline width is exactly the fit width (standard 16:9 at 1280).
  const pxToEmu = +(9525 / slide.scale).toFixed(2)
  return `Canvas ${slide.widthPx}×${slide.heightPx}px (1 px = ${pxToEmu} EMU)\n${parts.join('\n---\n') || '(no elements on this page)'}${colorNote}`
}

/** Optional hosted tools that can be disabled by the runtime configuration. */
const GSK_ONLY_TOOLS = new Set(['generate_image', 'analyze_media'])

const GSK_TOOLS_OFF_NOTE =
  '\n\nNote: generate_image and analyze_media are currently unavailable. Do not call or promise them; for imagery use image_search + insert_web_image instead.'

const RESEARCH_MODE_EXCLUDED_TOOLS = new Set([
  'generate_deck',
  'plan_deck',
  'regenerate_slide',
  'save_style_template',
  'list_style_templates',
])
// Hidden from the research-mode AGENT TOOL LIST so a NEW figure can only be
// produced by create_research_figure (acceptance RF-FIX-002 — the model twice
// drifted to the legacy recipe tools when they were visible). Unlike
// RESEARCH_MODE_EXCLUDED_TOOLS these remain executable via executeTool for
// tests and programmatic FigurePlan execution.
const RESEARCH_MODE_HIDDEN_TOOLS = new Set([
  'plan_research_figure',
  'create_input_core_output',
  'create_horizontal_pipeline',
])
const RESEARCH_MODE_ONLY_TOOLS = new Set(['plan_research_figure', 'create_research_figure'])

export type SlidesSkillMode = 'research' | 'presentation'

export function createSlidesSkill(
  access: DeckAccess,
  mode: SlidesSkillMode = 'presentation',
): AgentSkill {
  // The HTML pipeline was already used in this conversation → later calls without an explicit mode default to append.
  // Safety net for when the AI ignores the "pass all pages at once" constraint: separate calls no longer overwrite each other (P0-1).
  const state: SkillState = { htmlGenerated: false, mode }
  return {
    id: 'slides',
    // live like tools: the off-note overrides the prose that still mentions the hidden tools
    get systemPrompt() {
      const prompt = effectivePrompt(
        mode === 'research' ? 'agent.research' : 'agent.presentation',
        mode === 'research' ? RESEARCH_AGENT_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT,
      )
      return access.gskTools?.() === false ? prompt + GSK_TOOLS_OFF_NOTE : prompt
    },
    // live view: gskTools is re-read before every model request
    get tools() {
      const modeTools =
        mode === 'research'
          ? TOOLS.filter(
              (tool) =>
                !RESEARCH_MODE_EXCLUDED_TOOLS.has(tool.name) &&
                !RESEARCH_MODE_HIDDEN_TOOLS.has(tool.name),
            )
          : TOOLS.filter((tool) => !RESEARCH_MODE_ONLY_TOOLS.has(tool.name))
      return access.gskTools?.() === false
        ? modeTools.filter((t) => !GSK_ONLY_TOOLS.has(t.name))
        : modeTools
    },
    buildContext: () => {
      const outline = `<deck outline>\n${buildDeckOutline(access.getSlides(), access.getCurrent(), access.getSelectedIds())}\n</deck outline>`
      const figurePlan = state.lastFigurePlan
        ? `<figure-plan>\n${JSON.stringify(state.lastFigurePlan, null, 2)}\n</figure-plan>`
        : ''
      const progress = buildProgressNote(state)
      // Research mode: when the deck has no real content yet, remind EVERY turn
      // that the only creation path is create_research_figure (weak models
      // otherwise drift into hand-assembly dead ends - acceptance RF-FIX-002).
      const blankResearchNote =
        mode === 'research' &&
        !state?.htmlGenerated &&
        access.getSlides().every((slide) => slide.nodes.length === 0)
          ? '<research-mode-note>画布仍为空：请立即调用 create_research_figure（把研究需求作为 thesis 传入）。不要用 add_shape/add_text_box 手工搭图。</research-mode-note>'
          : ''
      return [outline, figurePlan, progress, blankResearchNote].filter(Boolean).join('\n')
    },
    reset: () => {
      state.htmlGenerated = false
      state.lastFigurePlan = undefined
      state.webSearched = undefined
      state.plannedPages = undefined
      state.plannedTitles = undefined
      state.pageDone = undefined
      state.lastStyleSkill = undefined
      state.lastTopic = undefined
    },
    executeTool: (call, signal) => executeTool(access, call, state, signal, mode),
  }
}

interface SkillState {
  htmlGenerated: boolean
  mode: SlidesSkillMode
  /** Most recent validated research FigurePlan, injected into subsequent turns. */
  lastFigurePlan?: FigurePlan
  /** A web_search ran in this conversation — unlocks dataSource:'search' in the figure gate */
  webSearched?: boolean
  /** Number of pages most recently planned by plan_deck, used by the presentation progress checklist */
  plannedPages?: number
  /** Per-page titles planned by plan_deck (order = page order), used to name unfinished pages in the checklist */
  plannedTitles?: string[]
  /** Whether each planned page has been generated (aligned with plannedTitles) — names unfinished pages accurately even when a middle page fails */
  pageDone?: boolean[]
  /** Style Skill produced by the most recent generate_deck (used by save_style_template) */
  lastStyleSkill?: string
  /** Topic of the most recent generate_deck (used by save_style_template) */
  lastTopic?: string
}

/**
 * [Hard constraint against "hand-building from scratch"] Sometimes the AI skips the HTML
 * pipeline and assembles a whole deck element by element with add_text_box/add_shape/add_smartart —
 * such hand-built pages look crude and the layout falls apart (root cause of screenshot issues).
 * "From-scratch" detection: this session hasn't used the HTML pipeline (!htmlGenerated) AND the
 * deck has almost no real content (≤ 2 non-decoration elements with text, i.e. blank/initial
 * template). If so, reject and steer toward generate_deck. Adding a single element to an
 * existing rich deck / fine-tuning after the HTML pipeline are unaffected.
 */
function blockScratchBuild(
  toolName: string,
  slides: RenderSlide[],
  state?: SkillState,
): { output: string; isError: true; mutated: false; summary: string } | null {
  if (state?.htmlGenerated) return null // Went through the HTML pipeline; subsequent native edits are legitimate
  let contentEls = 0
  for (const slide of slides) {
    for (const n of collectNodeInfos(slide.nodes)) {
      if (!n.locked && n.text && n.text.trim() !== '') contentEls += 1
    }
  }
  if (contentEls > 2) return null // Deck already has real content; this is a refinement scenario, allow it
  const label = toolName === 'add_smartart' ? t('aiLabelInsertSmartart') : t('aiFailNewElement')
  if (state?.mode === 'research') {
    return {
      output:
        'For a research figure, do not hand-assemble a page element by element. ' +
        'Call create_research_figure with the research request: it runs the full pipeline ' +
        '(semantic planning, composition candidates, native connector routing, layout audit) ' +
        'and creates the editable figure in one step. Legacy plan_research_figure / Recipe tools are retired for new figures.',
      isError: true,
      mutated: false,
      summary: '已拦截手工搭建：改用 create_research_figure 创建科研图',
    }
  }
  return {
    output:
      "For blank/from-scratch scenarios don't hand-assemble pages element by element with add_text_box/add_shape/add_smartart (crude layout). " +
      'Use the generation pipeline instead: new whole deck → generate_deck; new pages for an existing deck → generate_deck(pages, insert_mode:"append"). ' +
      'Write it beautifully in HTML/CSS and the system converts it into editable elements. Use native tools only when the deck already has polished content and one element needs refining.',
    isError: true,
    mutated: false,
    summary: t('aiSumFromScratchGuard', { label }),
  }
}

/**
 * Build the generation progress checklist text — injected to the AI each turn via buildContext
 * so it "sees" which pages are still missing, a mechanical reminder to finish (rather than a
 * one-shot prompt constraint). Returns an empty string when there is no plan.
 */
function buildProgressNote(state?: SkillState): string {
  if (!state || state.mode === 'research' || !state.plannedPages) return ''
  const planned = state.plannedPages
  const flags = state.pageDone ?? new Array(planned).fill(false)
  const done = flags.filter(Boolean).length
  const titles = state.plannedTitles ?? []
  if (done >= planned) {
    return `<generation-progress>\n✅ Complete: ${planned} pages planned, all generated (${done} pages).\n</generation-progress>`
  }
  // Name unfinished pages one by one from pageDone (page numbers stay accurate when a middle page fails)
  const remaining: string[] = []
  for (let i = 0; i < planned; i++) {
    if (!flags[i]) remaining.push(`page ${i + 1}${titles[i] ? ` "${titles[i]}"` : ''}`)
  }
  return (
    `<generation-progress>\n` +
    `⚠️ Incomplete: ${planned} pages planned, ${done} generated, ${planned - done} still missing.\n` +
    `Unfinished: ${remaining.join(', ')}.\n` +
    `Immediately fill in the unfinished pages above with generate_deck(pages: briefs for the missing pages, insert_mode:"append"); do not stop and do not substitute native tools.\n` +
    `</generation-progress>`
  )
}

const fail = (summary: string, output: string) => ({
  output,
  isError: true,
  mutated: false,
  summary,
})

async function revertCreatedElements(
  access: DeckAccess,
  slideIndex: number,
  sourceIds: string[],
): Promise<string[]> {
  const errors: string[] = []
  for (const sourceId of [...sourceIds].reverse()) {
    try {
      const restored = await window.slidesApi.deleteElement({ slideIndex, sourceId })
      if (!restored) errors.push(sourceId)
      else access.applySlide(slideIndex, restored)
    } catch {
      errors.push(sourceId)
    }
  }
  return errors
}

// ── Figure-provenance gate ────────────────────────────────────
// Prompt rules ("search before writing data") did not stop invented numbers being
// delivered as fact, so provenance is enforced at the tool layer: chart data and
// data-dense briefs must declare a dataSource, 'search' is only accepted after a
// real web_search in this conversation, and 'sample' figures must be disclosed.

/** Specific figures: percentages, money, magnitude units, decimals — not bare years/counts */
const SPECIFIC_FIGURE_RE =
  /\d[\d,.]*\s*(?:%|％|亿|萬|万|兆|billion|million|\bbn\b|\bmn\b)|[¥￥$€£]\s*\d|\d+\.\d+/g

function countSpecificFigures(text: string): number {
  return text.match(SPECIFIC_FIGURE_RE)?.length ?? 0
}

/**
 * Returns an error message when the declared dataSource does not justify the figures
 * this call carries, null when the call may proceed.
 */
function dataSourceGateError(call: AgentToolCall, state: SkillState | undefined): string | null {
  const src = String(call.input.dataSource ?? '')
  if (src === 'user' || src === 'document' || src === 'sample') return null
  if (src === 'search') {
    if (state?.webSearched) return null
    return (
      "dataSource is 'search' but no web_search has run in this conversation. " +
      'Run web_search first and build the figures from the results (cite them to the user), ' +
      "or declare 'user'/'document' if the figures actually came from the user or this deck."
    )
  }
  return (
    'This call carries specific figures, so dataSource is required: ' +
    "'user' (figures supplied by the user or attachments), 'document' (read from this deck), " +
    "'search' (from web_search results — run it first), or 'sample' (illustrative placeholders; " +
    'you must tell the user they are NOT real data). Never present invented numbers as facts.'
  )
}

/** Appended to a successful tool output when the model declared the figures illustrative. */
const SAMPLE_DATA_NOTE =
  '\nNOTE: dataSource is "sample" — you MUST tell the user these figures are illustrative placeholders, not real data, and offer to research real numbers with web_search.'

const RESEARCH_FIGURE_TYPES = new Set<FigurePlan['figureType']>([
  'input-core-output',
  'horizontal-pipeline',
])

const RESEARCH_REGION_ROLES = new Set<FigurePlan['regions'][number]['role']>([
  'input',
  'core',
  'output',
  'context',
  'feedback',
])

const RESEARCH_EDGE_ROLES = new Set<FigurePlan['edges'][number]['role']>([
  'main',
  'feedback',
  'annotation',
])

function parseResearchFigurePlan(input: Record<string, unknown>): FigurePlan | null {
  const figureType = input.figureType
  const readingDirection = input.readingDirection
  const rawRegions = input.regions
  const rawNodes = input.nodes
  const rawEdges = input.edges
  const rawConstraints = input.negativeConstraints
  if (
    typeof figureType !== 'string' ||
    !RESEARCH_FIGURE_TYPES.has(figureType as FigurePlan['figureType']) ||
    readingDirection !== 'LR' ||
    !Array.isArray(rawRegions) ||
    rawRegions.length === 0 ||
    !Array.isArray(rawNodes) ||
    rawNodes.length === 0 ||
    !Array.isArray(rawEdges) ||
    !Array.isArray(rawConstraints)
  ) {
    return null
  }

  const allowedRegionRoles =
    figureType === 'input-core-output'
      ? new Set<FigurePlan['regions'][number]['role']>(['input', 'core', 'output'])
      : new Set<FigurePlan['regions'][number]['role']>(['context'])
  const allowedEdgeRoles =
    figureType === 'input-core-output'
      ? new Set<FigurePlan['edges'][number]['role']>(['main', 'feedback'])
      : new Set<FigurePlan['edges'][number]['role']>(['main'])

  const regionIds = new Set<string>()
  const regions: FigurePlan['regions'] = []
  for (const raw of rawRegions) {
    const region = raw as Record<string, unknown>
    const id = typeof region.id === 'string' ? region.id.trim() : ''
    const role = region.role
    if (
      !id ||
      regionIds.has(id) ||
      typeof role !== 'string' ||
      !RESEARCH_REGION_ROLES.has(role as FigurePlan['regions'][number]['role']) ||
      !allowedRegionRoles.has(role as FigurePlan['regions'][number]['role'])
    ) {
      return null
    }
    regionIds.add(id)
    regions.push({ id, role: role as FigurePlan['regions'][number]['role'] })
  }

  const nodes: FigurePlan['nodes'] = []
  for (const raw of rawNodes) {
    const node = raw as Record<string, unknown>
    const region = typeof node.region === 'string' ? node.region.trim() : ''
    const component = typeof node.component === 'string' ? node.component.trim() : ''
    const title = typeof node.title === 'string' ? node.title.trim() : ''
    if (!region || !regionIds.has(region) || !component || !title) return null
    nodes.push({ region, component, title })
  }

  const edgeRefs = new Set([...regionIds, ...nodes.map((node) => node.title)])
  // existence-only table: one distinct slot per ref so cross-endpoint pairs
  // never collapse into a dropped self pair
  let refSlot = 0
  const refTable = endpointTable([...edgeRefs].map((ref) => ({ ref, indices: [refSlot++] })))
  const parsedEdges = parseSemanticEdges(rawEdges, [refTable, refTable])
  if (!parsedEdges) return null
  for (const edge of parsedEdges) {
    if (!allowedEdgeRoles.has(edge.role)) return null
  }
  const edges: FigurePlan['edges'] = parsedEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    role: edge.role,
    relation: edge.relation,
    ...(edge.label ? { label: edge.label } : {}),
    ...(edge.id ? { id: edge.id } : {}),
    ...(edge.targetEdge ? { targetEdge: edge.targetEdge } : {}),
  }))

  const negativeConstraints = rawConstraints
    .filter((constraint): constraint is string => typeof constraint === 'string')
    .map((constraint) => constraint.trim())
    .filter(Boolean)
  if (negativeConstraints.length !== rawConstraints.length) return null

  return {
    figureType: figureType as FigurePlan['figureType'],
    readingDirection: 'LR',
    regions,
    nodes,
    edges,
    negativeConstraints,
  }
}

type ResearchRecipeNode = { component: string; title: string; subtitle?: string }

interface ResearchRecipeNodeGroups {
  input?: ResearchRecipeNode[]
  core?: ResearchRecipeNode[]
  output?: ResearchRecipeNode[]
  pipeline?: ResearchRecipeNode[]
}

type ResearchRecipeType = 'input-core-output' | 'horizontal-pipeline'

function researchRecipeText(nodes: ResearchRecipeNode[]): string {
  return nodes.flatMap((node) => [node.title, node.subtitle ?? '']).join('\n')
}

function researchRecipeDataSourceError(
  call: AgentToolCall,
  state: SkillState | undefined,
  nodes: ResearchRecipeNode[],
): string | null {
  return countSpecificFigures(researchRecipeText(nodes)) > 0
    ? dataSourceGateError(call, state)
    : null
}

type ResearchRecipeRoute = { fromRef: string; toRef: string; role: 'main' | 'feedback' }

function researchNodeMismatch(
  expected: FigurePlan['nodes'],
  actual: ResearchRecipeNode[],
  label: string,
): string | null {
  if (expected.length !== actual.length) {
    return `${label} has ${actual.length} nodes, but the FigurePlan has ${expected.length}`
  }
  for (let i = 0; i < expected.length; i++) {
    const planned = expected[i]!
    const received = actual[i]!
    if (planned.component !== received.component || planned.title !== received.title) {
      return `${label} node ${i + 1} is ${received.component}/${received.title}, but the FigurePlan requires ${planned.component}/${planned.title}`
    }
  }
  return null
}

function edgeRefMatches(ref: string, nodeRef: string): boolean {
  return ref === nodeRef
}

/**
 * Plan-gate topology check. Recipes draw connectors EXCLUSIVELY from the
 * plan's explicit edges (never positional order), so the recipe's declared
 * route refs must cover every plan edge verbatim.
 */
function researchRouteMismatch(plan: FigurePlan, routes: ResearchRecipeRoute[]): string | null {
  for (const edge of plan.edges) {
    if (edge.role !== 'main' && edge.role !== 'feedback') {
      return `the ${edge.role} relationship ${edge.from} -> ${edge.to} is not supported by this Recipe`
    }
    const matches = routes.some(
      (route) =>
        edge.role === route.role &&
        edgeRefMatches(edge.from, route.fromRef) &&
        edgeRefMatches(edge.to, route.toRef),
    )
    if (!matches) {
      return `the ${edge.role} relationship ${edge.from} -> ${edge.to} is not supported by this Recipe`
    }
  }
  return null
}

/** Research Recipes may only execute the latest Planner output, never an unrelated node list. */
function researchRecipePlanError(
  mode: SlidesSkillMode,
  state: SkillState | undefined,
  figureType: ResearchRecipeType,
  groups: ResearchRecipeNodeGroups,
  feedback = false,
): string | null {
  if (mode !== 'research') return null
  const plan = state?.lastFigurePlan
  if (!plan) {
    return `Call plan_research_figure before the ${figureType} Recipe so it can use a validated FigurePlan.`
  }
  if (plan.figureType !== figureType) {
    return `Recipe ${figureType} does not match the current FigurePlan (${plan.figureType}); call plan_research_figure again for this figure type.`
  }
  if (plan.readingDirection !== 'LR') {
    return `Recipe ${figureType} does not match the current FigurePlan: this Recipe currently supports LR reading direction only.`
  }

  // Connector routes come verbatim from the plan's explicit edges — the gate
  // verifies node/group consistency, never a positional chain.
  const expectedRoutes: ResearchRecipeRoute[] = plan.edges.flatMap((edge) =>
    edge.role === 'main' || edge.role === 'feedback'
      ? [{ fromRef: edge.from, toRef: edge.to, role: edge.role }]
      : [],
  )
  if (figureType === 'horizontal-pipeline') {
    const expected = plan.nodes
    const actual = groups.pipeline ?? []
    const nodeError = researchNodeMismatch(expected, actual, 'Pipeline')
    if (nodeError) return `Recipe ${figureType} does not match the current FigurePlan: ${nodeError}`
  } else {
    const regionRoles = new Map(plan.regions.map((region) => [region.id, region.role]))
    const expected: Record<'input' | 'core' | 'output', FigurePlan['nodes']> = {
      input: [],
      core: [],
      output: [],
    }
    for (const node of plan.nodes) {
      const role = regionRoles.get(node.region)
      if (role !== 'input' && role !== 'core' && role !== 'output') {
        return `Recipe ${figureType} does not match the current FigurePlan: node ${node.title} belongs to unsupported region role ${role ?? 'unknown'}`
      }
      expected[role].push(node)
    }

    const actualInput = groups.input ?? []
    const actualCore = groups.core ?? []
    const actualOutput = groups.output ?? []
    const nodeMismatches = [
      researchNodeMismatch(expected.input, actualInput, 'Input'),
      researchNodeMismatch(expected.core, actualCore, 'Core'),
      researchNodeMismatch(expected.output, actualOutput, 'Output'),
    ].filter((message): message is string => Boolean(message))
    if (nodeMismatches.length > 0) {
      return `Recipe ${figureType} does not match the current FigurePlan: ${nodeMismatches[0]}`
    }

    const plannedFeedback = plan.edges.some((edge) => edge.role === 'feedback')
    if (plannedFeedback !== feedback) {
      return `Recipe ${figureType} does not match the current FigurePlan: feedback is ${plannedFeedback ? 'required' : 'not declared'} by the plan`
    }
  }

  const routeError = researchRouteMismatch(plan, expectedRoutes)
  return routeError
    ? `Recipe ${figureType} does not match the current FigurePlan: ${routeError}`
    : null
}

/** Append the missing-image report to the tool output: the model learns which pages lack images and how to fix them, instead of silently treating it as success. */
function imageFailNote(fails?: { page: number; url: string }[]): string {
  if (!fails?.length) return ''
  const detail = fails.map((f) => `page ${f.page} (${f.url})`).join(', ')
  return `\n⚠️ Missing images: ${detail} failed to download/convert; those image slots are blank on the page. Re-run image_search with more generic English keywords, pick a working image, patch it onto the page with insert_web_image (slideIndex = page number - 1), then reply to the user.`
}

/** Fit generated node copy using the same renderer-backed text path as manual edits. */
async function fitResearchNodeText(
  access: DeckAccess,
  slideIndex: number,
  sourceId: string,
  title: string,
  signal?: AbortSignal,
): Promise<RenderSlide> {
  throwIfAborted(signal)
  const fitted = await window.slidesApi.setTextBodyProps({
    slideIndex,
    sourceId,
    props: { autofit: 'shrink' },
  })
  if (!fitted) throw new Error(`Failed to fit text for node "${title}"`)
  throwIfAborted(signal)
  access.applySlide(slideIndex, fitted)
  return fitted
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation cancelled')
}

async function executeTool(
  access: DeckAccess,
  call: AgentToolCall,
  state?: SkillState,
  signal?: AbortSignal,
  mode: SlidesSkillMode = state?.mode ?? 'presentation',
) {
  if (mode === 'research' && RESEARCH_MODE_EXCLUDED_TOOLS.has(call.name)) {
    return fail(
      t('aiFailPlan'),
      'This presentation-only operation is unavailable in Research Figure Mode; use plan_research_figure and a research Recipe instead.',
    )
  }
  const slides = access.getSlides()
  switch (call.name) {
    case 'get_deck_context':
      return {
        output: buildDeckOutline(slides, access.getCurrent(), access.getSelectedIds()),
        mutated: false,
        summary: t('aiSumDeckContext'),
      }

    case 'read_slide': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailReadSlide'), `slideIndex out of range (0-${slides.length - 1})`)
      return {
        output: formatSlideDump(slide),
        mutated: false,
        summary: t('aiSumReadSlide', { n: idx + 1 }),
      }
    }

    case 'set_element_text': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailEditText'), `slideIndex out of range (0-${slides.length - 1})`)
      const paragraphs = toEditParagraphs(call.input.paragraphs)
      if (!paragraphs) return fail(t('aiFailEditText'), 'paragraphs must be a non-empty array')
      const target = resolveEditTarget(slide, sourceId)
      const terr = targetError(target, sourceId, idx + 1, slides[idx])
      if (terr || !target || 'nested' in target) return fail(t('aiFailEditText'), terr!)
      const updated = await window.slidesApi.editText({
        slideIndex: idx,
        sourceId,
        paragraphs,
        ...(target.groupId ? { groupId: target.groupId } : {}),
      })
      if (!updated)
        return fail(
          t('aiFailEditText'),
          `Element ${sourceId} (${target.node.type}) does not support text editing` +
            (target.node.type === 'table'
              ? '; use edit_table_cell for tables'
              : target.node.type === 'chart'
                ? '; use edit_chart for charts'
                : ''),
        )
      access.applySlide(idx, updated)
      return {
        output: `Replaced the text of element ${sourceId} on page ${idx + 1} (${paragraphs.length} paragraphs).`,
        mutated: true,
        summary: t('aiSumEditText', { n: idx + 1 }),
      }
    }

    case 'set_element_style': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const slide = slides[idx]
      if (!slide) return fail(t('aiFailStyle'), `slideIndex out of range (0-${slides.length - 1})`)
      const target = resolveEditTarget(slide, sourceId)
      const terr = targetError(target, sourceId, idx + 1, slides[idx])
      if (terr || !target || 'nested' in target) return fail(t('aiFailStyle'), terr!)
      const node = target.node
      if (!(node.type === 'text' || node.type === 'shape')) {
        return fail(t('aiFailStyle'), `Element ${sourceId} (${node.type}) has no editable text`)
      }
      const cur = nodeToParagraphs(node as ShapeRenderNode)
      if (!cur.length) return fail(t('aiFailStyle'), 'This element has no text to format')
      const ov = call.input as SlideStylePatch
      const paragraphs = mergeStyleIntoParagraphs(cur, ov)
      const updated = await window.slidesApi.editText({
        slideIndex: idx,
        sourceId,
        paragraphs,
        ...(target.groupId ? { groupId: target.groupId } : {}),
      })
      if (!updated)
        return fail(t('aiFailStyle'), `Element ${sourceId} does not support format editing`)
      access.applySlide(idx, updated)
      return {
        output: `Updated the formatting of element ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumStyle', { n: idx + 1 }),
      }
    }

    case 'set_element_transform': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailTransform'), `slideIndex out of range (0-${slides.length - 1})`)
      const target = resolveEditTarget(slide, sourceId)
      const terr = targetError(target, sourceId, idx + 1, slides[idx])
      if (terr || !target || 'nested' in target) return fail(t('aiFailTransform'), terr!)
      const b = target.node.box
      // Group-child render boxes are group-local; the tool takes absolute px, so convert both ways via the group origin
      const origin = target.groupOrigin ?? { x: 0, y: 0 }
      const inp = call.input as {
        x?: number
        y?: number
        w?: number
        h?: number
        rotationDeg?: number
      }
      const updated = await window.slidesApi.editTransform({
        slideIndex: idx,
        sourceId,
        ...(target.groupId ? { groupId: target.groupId } : {}),
        xPx: (typeof inp.x === 'number' ? inp.x : origin.x + b.x) - origin.x,
        yPx: (typeof inp.y === 'number' ? inp.y : origin.y + b.y) - origin.y,
        wPx: typeof inp.w === 'number' ? inp.w : b.w,
        hPx: typeof inp.h === 'number' ? inp.h : b.h,
        rotationDeg: typeof inp.rotationDeg === 'number' ? inp.rotationDeg : b.rotationDeg,
        fitWidthPx: access.fitWidthPx,
      })
      if (!updated) return fail(t('aiFailTransform'), 'Transform failed')
      access.applySlide(idx, updated)
      const afterTarget = resolveEditTarget(updated, sourceId)
      const after = afterTarget && !('nested' in afterTarget) ? afterTarget : null
      const nb = after
        ? {
            ...after.node.box,
            x: (after.groupOrigin?.x ?? 0) + after.node.box.x,
            y: (after.groupOrigin?.y ?? 0) + after.node.box.y,
          }
        : undefined
      const boxStr = nb
        ? `New geometry: pos(${Math.round(nb.x)},${Math.round(nb.y)}) size ${Math.round(nb.w)}×${Math.round(nb.h)}.`
        : ''
      const issues = auditSlideLayout(updated)
      const auditStr = issues.length
        ? `\n⚠️ The layout audit found ${issues.length} issue(s) on this page:\n${issues.map((s) => `- ${s}`).join('\n')}\nFor multi-element layout adjustments switch to execute_slide_script (it reads every element's real geometry and applies atomically).`
        : ''
      return {
        output: `Adjusted the position/size of element ${sourceId} on page ${idx + 1}. ${boxStr}${auditStr}`,
        mutated: true,
        summary: t('aiSumTransform', { n: idx + 1 }),
      }
    }

    // execute_layout_script is a legacy alias (avoids breaking existing sessions/prompts); both share the same logic
    case 'execute_layout_script':
    case 'execute_slide_script': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide) return fail(t('aiFailScript'), `slideIndex out of range (0-${slides.length - 1})`)
      // P0.5 acceptance closure: execute_slide_script can CREATE elements, so a
      // research-mode agent on an empty canvas must not use it to hand-assemble
      // a figure and bypass the create_research_figure hard gates. Presentation
      // mode keeps its historical script-on-blank allowance (power-user layouts).
      const scratchBlock =
        state?.mode === 'research' ? blockScratchBuild(call.name, slides, state) : null
      if (scratchBlock) return scratchBlock
      const code = String(call.input.code ?? '').trim()
      if (!code) return fail(t('aiFailScript'), 'code must not be empty')
      const infos = collectNodeInfos(slide.nodes)
      const r = runLayoutScript(code, infos, { w: slide.widthPx, h: slide.heightPx })
      const logsStr = r.logs.length ? `\nlog output:\n${r.logs.join('\n')}` : ''
      if (r.error) {
        return fail(
          t('aiFailScript'),
          `Script execution error: ${r.error}${logsStr}\n(You can fix the script and retry; see els for the element list and geometry)`,
        )
      }
      const returnedStr = r.returned !== undefined ? `\nScript returned: ${r.returned}` : ''
      if (r.ops.length === 0 && r.edits.length === 0) {
        return {
          output: `Script finished but called no edit primitives (setBox/moveBy/setText/setStyle/setFill/setStroke); the page was not modified.${returnedStr}${logsStr}`,
          mutated: false,
          summary: t('aiSumScriptNoop', { n: idx + 1 }),
        }
      }
      // ── Dispatch: the whole script is ONE transaction — the collected primitives go
      //   to the main process in a single IPC and apply atomically through the op
      //   executor (any failure rolls the deck back there and returns a guided error).
      const applied = await window.slidesApi.applyEditScript({
        slideIndex: idx,
        fitWidthPx: access.fitWidthPx,
        boxes: r.ops,
        edits: r.edits,
      })
      if (!applied || 'error' in applied) {
        return fail(
          t('aiFailScript'),
          `${applied && 'error' in applied ? applied.error : t('aiErrUnknown')}\n` +
            `The page is unchanged (the script is atomic). Elements on page ${idx + 1}: ` +
            `[${availableIdList(slide, true)}]. Fix the script and resend it whole.${returnedStr}${logsStr}`,
        )
      }
      access.applySlide(idx, applied.slide)
      const counts = { text: 0, style: 0, fill: 0, stroke: 0 }
      for (const e of r.edits) counts[e.kind] += 1
      const parts: string[] = []
      if (r.ops.length > 0) parts.push(`layout ${r.ops.length} element(s)`)
      if (counts.text > 0) parts.push(`text ${counts.text} item(s)`)
      if (counts.style > 0) parts.push(`style ${counts.style} item(s)`)
      if (counts.fill > 0) parts.push(`fill ${counts.fill} item(s)`)
      if (counts.stroke > 0) parts.push(`stroke ${counts.stroke} item(s)`)
      const issues = auditSlideLayout(applied.slide)
      return {
        output: `Applied the edit script to page ${idx + 1}: ${parts.join(', ')}.${returnedStr}${logsStr}${formatAudit(issues)}`,
        mutated: true,
        summary: t('aiSumScript', { n: idx + 1, count: r.ops.length + r.edits.length }),
      }
    }

    case 'set_element_fill': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailFill'), `slideIndex out of range (0-${slides.length - 1})`)
      const target = resolveEditTarget(slides[idx]!, sourceId)
      const terr = targetError(target, sourceId, idx + 1, slides[idx])
      if (terr || !target || 'nested' in target) return fail(t('aiFailFill'), terr!)
      const updated = await window.slidesApi.editFill({
        slideIndex: idx,
        sourceId,
        fill: String(call.input.fill),
        ...(target.groupId ? { groupId: target.groupId } : {}),
      })
      if (!updated) return fail(t('aiFailFill'), `Element ${sourceId} does not support fill`)
      access.applySlide(idx, updated)
      return {
        output: `Set the fill of element ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumFill', { n: idx + 1 }),
      }
    }

    case 'set_element_stroke': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailStroke'), `slideIndex out of range (0-${slides.length - 1})`)
      const remove = call.input.remove === true
      const stroke = remove
        ? null
        : { color: String(call.input.color ?? '#000000'), widthPt: Number(call.input.widthPt ?? 1) }
      const target = resolveEditTarget(slides[idx]!, sourceId)
      const terr = targetError(target, sourceId, idx + 1, slides[idx])
      if (terr || !target || 'nested' in target) return fail(t('aiFailStroke'), terr!)
      const updated = await window.slidesApi.editStroke({
        slideIndex: idx,
        sourceId,
        stroke,
        ...(target.groupId ? { groupId: target.groupId } : {}),
      })
      if (!updated) return fail(t('aiFailStroke'), `Element ${sourceId} does not support stroke`)
      access.applySlide(idx, updated)
      return {
        output: `${remove ? 'Removed' : 'Set'} the stroke of element ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumStroke', { n: idx + 1 }),
      }
    }

    case 'web_search': {
      const query = String(call.input.query ?? '').trim()
      if (!query) return fail(t('aiFailWebSearch'), 'query must not be empty')
      const r = await window.slidesApi.webSearch(query, Number(call.input.maxResults) || 6)
      // a backend failure must not read as "no results" — the model would fabricate conclusions
      if (r.method === 'error') {
        return fail(
          t('aiFailWebSearch'),
          `web search failed (service error, not an empty result — you may retry): ${r.error ?? 'unknown error'}`,
        )
      }
      if (state) state.webSearched = true
      // output for the LLM: title+URL+summary (each summary truncated to 120 chars to stay lean)
      const SNIPPET_MAX = 120
      const lines: string[] = []
      if (r.answer) lines.push(`Direct answer: ${r.answer.slice(0, 300)}\n`)
      r.results.forEach((it, i) => {
        const snip =
          it.snippet.length > SNIPPET_MAX ? it.snippet.slice(0, SNIPPET_MAX) + '…' : it.snippet
        lines.push(`${i + 1}. ${it.title}\n   ${it.url}\n   ${snip}`)
      })
      // display side channel: link list (full title+URL for the UI, not in LLM context)
      const display: ToolDisplay = {
        kind: 'links',
        items: r.results.map((it) => ({ url: it.url, title: it.title })),
      }
      return {
        output: lines.join('\n') || '(no results)',
        mutated: false,
        summary: t('aiSumWebSearch', { query, count: r.results.length }),
        display,
      }
    }

    case 'image_search': {
      const query = String(call.input.query ?? '').trim()
      if (!query) return fail(t('aiFailImageSearch'), 'query must not be empty')
      const r = await window.slidesApi.imageSearch(query, Number(call.input.maxResults) || 8)
      // a backend failure must not read as an empty gallery — the model would fabricate image choices
      if (r.method === 'error') {
        return fail(
          t('aiFailImageSearch'),
          `image search failed (service error, not an empty result — you may retry): ${r.error ?? 'unknown error'}`,
        )
      }
      // output for the LLM: keep the existing format (the LLM needs to read URLs into image_queries; format unchanged)
      const lines = r.images.map(
        (im, i) =>
          `${i + 1}. ${im.title || '(untitled)'} [${im.width ?? '?'}x${im.height ?? '?'}]\n   ${im.imageUrl}`,
      )
      // display side channel: image list (for UI thumbnails, not in LLM context)
      const display: ToolDisplay = {
        kind: 'images',
        items: r.images.map((im) => ({ url: im.imageUrl, title: im.title || undefined })),
      }
      return {
        output: lines.join('\n') || '(no images)',
        mutated: false,
        summary: t('aiSumImageSearch', { query, count: r.images.length }),
        display,
      }
    }

    case 'generate_image': {
      const prompt = String(call.input.prompt ?? '').trim()
      if (!prompt) return fail(t('aiFailGenImage'), 'prompt must not be empty')
      const refs = Array.isArray(call.input.referenceImageUrls)
        ? (call.input.referenceImageUrls as unknown[]).map(String).filter(Boolean)
        : undefined
      const r = await window.slidesApi.generateImage({
        prompt,
        model: call.input.model ? String(call.input.model) : undefined,
        referenceImageUrls: refs,
        aspectRatio: call.input.aspectRatio ? String(call.input.aspectRatio) : undefined,
      })
      if (!r.url) return fail(t('aiFailGenImage'), r.error ?? 'Generation failed')
      const display: ToolDisplay = {
        kind: 'images',
        items: [{ url: r.url, title: prompt.slice(0, 60) }],
      }
      return {
        output:
          `Image generated, URL: ${r.url}\n` +
          'New imagery: insert it with insert_web_image. If this edits an existing slide picture (e.g. background removal), swap it in place with replace_image instead.',
        mutated: false,
        summary: t('aiSumGenImage', {
          prompt: `${prompt.slice(0, 20)}${prompt.length > 20 ? '…' : ''}`,
        }),
        display,
      }
    }

    case 'analyze_media': {
      const mediaUrls = Array.isArray(call.input.mediaUrls)
        ? (call.input.mediaUrls as unknown[]).map(String).filter(Boolean)
        : []
      const requirements = String(call.input.requirements ?? '').trim()
      if (!mediaUrls.length) return fail(t('aiFailMedia'), 'mediaUrls must not be empty')
      if (!requirements) return fail(t('aiFailMedia'), 'requirements must not be empty')
      const r = await window.slidesApi.analyzeMedia({ mediaUrls, requirements })
      if (!r.text) return fail(t('aiFailMedia'), r.error ?? 'Analysis failed')
      // Analysis text can be very long; truncate to protect context (first 6000 chars are enough to generate deck content)
      const MAX_LEN = 6000
      const text = r.text.length > MAX_LEN ? r.text.slice(0, MAX_LEN) + '\n…(truncated)' : r.text
      return {
        output: text,
        mutated: false,
        summary: t('aiSumParseMedia', { count: mediaUrls.length }),
      }
    }

    case 'insert_web_image': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailInsertImage'), `slideIndex out of range (0-${slides.length - 1})`)
      const url = String(call.input.url ?? '')
      if (!/^https?:\/\//.test(url)) return fail(t('aiFailInsertImage'), 'Invalid url')
      const r = await window.slidesApi.insertImageUrl({
        slideIndex: idx,
        url,
        xPx: Number(call.input.x),
        yPx: Number(call.input.y),
        wPx: Number(call.input.w),
        hPx: Number(call.input.h),
        fitWidthPx: access.fitWidthPx,
      })
      if (!r)
        return fail(
          t('aiFailInsertImage'),
          'Download or insertion failed (the image may be inaccessible)',
        )
      access.applySlide(idx, r.slide)
      return {
        output: `Inserted the image on page ${idx + 1}, element id=${r.sourceId}.`,
        mutated: true,
        summary: t('aiSumInsertImage', { n: idx + 1 }),
      }
    }

    case 'crop_image':
    case 'set_picture_opacity':
    case 'replace_image': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const failKey =
        call.name === 'crop_image'
          ? ('aiFailCropImage' as const)
          : call.name === 'set_picture_opacity'
            ? ('aiFailPictureOpacity' as const)
            : ('aiFailReplaceImage' as const)
      const slide = slides[idx]
      if (!slide) return fail(t(failKey), `slideIndex out of range (0-${slides.length - 1})`)
      const target = resolveEditTarget(slide, sourceId)
      const terr = targetError(target, sourceId, idx + 1, slides[idx])
      if (terr || !target || 'nested' in target) return fail(t(failKey), terr!)
      if (target.node.type !== 'picture')
        return fail(t(failKey), `Element ${sourceId} is not a picture (type: ${target.node.type})`)
      if (target.groupId)
        return fail(
          t(failKey),
          `Element ${sourceId} is inside a group; this tool only supports top-level pictures — ungroup_element first`,
        )

      if (call.name === 'crop_image') {
        const frac = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0))
        const cl = frac(call.input.l)
        const ct = frac(call.input.t)
        const cr = frac(call.input.r)
        const cb = frac(call.input.b)
        if (cl + cr >= 0.99 || ct + cb >= 0.99)
          return fail(t(failKey), 'Crop removes the whole image (l+r and t+b must be < 1)')
        const srcRect = cl || ct || cr || cb ? { l: cl, t: ct, r: cr, b: cb } : null
        const updated = await window.slidesApi.editPictureSrcRect({
          slideIndex: idx,
          sourceId,
          srcRect,
        })
        if (!updated) return fail(t(failKey), 'Crop failed')
        access.applySlide(idx, updated)
        return {
          output: srcRect
            ? `Cropped picture ${sourceId} on page ${idx + 1} (l=${cl} t=${ct} r=${cr} b=${cb}).`
            : `Removed the crop of picture ${sourceId} on page ${idx + 1}.`,
          mutated: true,
          summary: t('aiSumCropImage', { n: idx + 1 }),
        }
      }

      if (call.name === 'set_picture_opacity') {
        const opacity = Number(call.input.opacity)
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
          return fail(t(failKey), 'opacity must be between 0 and 1')
        const updated = await window.slidesApi.editPictureOpacity({
          slideIndex: idx,
          sourceId,
          opacity,
        })
        if (!updated) return fail(t(failKey), 'Opacity change failed')
        access.applySlide(idx, updated)
        return {
          output: `Set the opacity of picture ${sourceId} on page ${idx + 1} to ${opacity}.`,
          mutated: true,
          summary: t('aiSumPictureOpacity', { n: idx + 1 }),
        }
      }

      const url = String(call.input.url ?? '')
      if (!/^https?:\/\//.test(url)) return fail(t(failKey), 'Invalid url')
      const updated = await window.slidesApi.replacePictureUrl({
        slideIndex: idx,
        sourceId,
        url,
        ...(call.input.keepCrop ? { keepSrcRect: true } : {}),
      })
      if (!updated)
        return fail(
          t(failKey),
          'Replacement failed (the image may be inaccessible, or the element is not a replaceable picture)',
        )
      access.applySlide(idx, updated)
      return {
        output: `Replaced the image of picture ${sourceId} on page ${idx + 1} in place (frame/z-order/effects kept).`,
        mutated: true,
        summary: t('aiSumReplaceImage', { n: idx + 1 }),
      }
    }

    case 'ask_clarification': {
      if (!access.askClarification)
        return fail(
          t('aiFailClarify'),
          'The current environment does not support questionnaire cards',
        )
      const raw = Array.isArray(call.input.questions) ? call.input.questions : []
      const questions: ClarifyQuestion[] = raw
        .map((q: Record<string, unknown>, i: number) => ({
          id: String(q.id ?? `q${i + 1}`),
          label: String(q.label ?? ''),
          description: q.description ? String(q.description) : undefined,
          options: Array.isArray(q.options)
            ? q.options.map((o: unknown) => String(o)).slice(0, 5)
            : [],
          multi: !!q.multi,
        }))
        .filter((q) => q.label && q.options.length > 0)
      if (questions.length === 0)
        return fail(
          t('aiFailClarify'),
          'questions must be non-empty and every question needs options',
        )
      const r = await access.askClarification(questions)
      if (r.cancelled) {
        return {
          output:
            mode === 'research'
              ? 'The user skipped the questionnaire. Decide the FigurePlan yourself based on professional judgment and call plan_research_figure.'
              : 'The user skipped the questionnaire. Decide the Core Hook and style yourself based on professional judgment and generate directly.',
          mutated: false,
          summary: t('aiSumClarifySkipped'),
        }
      }
      return {
        output:
          mode === 'research'
            ? `User questionnaire answers:\n${r.answers}\nDecide the FigurePlan accordingly, then call plan_research_figure.`
            : `User questionnaire answers:\n${r.answers}\nDecide the Core Hook and style accordingly, then generate with generate_deck.`,
        mutated: false,
        summary: t('aiSumClarifyDone'),
      }
    }

    case 'plan_research_figure': {
      if (mode !== 'research') {
        return fail(
          t('aiFailPlan'),
          'plan_research_figure is only available in Research Figure Mode',
        )
      }
      const plan = parseResearchFigurePlan(call.input)
      if (!plan) {
        return fail(
          t('aiFailPlan'),
          'plan_research_figure requires a valid figureType, readingDirection, non-empty unique regions, non-empty nodes, valid edges, and string negativeConstraints',
        )
      }
      if (state) state.lastFigurePlan = plan
      return {
        output:
          `<figure-plan>\n${JSON.stringify(plan, null, 2)}\n</figure-plan>\n` +
          'Plan confirmed. Call the matching research Recipe next; the Recipe owns pixel geometry and creates editable native elements.',
        mutated: false,
        summary: `Research figure plan confirmed | ${plan.figureType}`,
      }
    }

    case 'plan_deck': {
      const coreHook = String(call.input.core_hook ?? '').trim()
      const style = String(call.input.style ?? '').trim()
      const pages = Array.isArray(call.input.pages) ? call.input.pages : []
      if (!coreHook || !style || pages.length === 0) {
        return fail(t('aiFailPlan'), 'plan_deck requires core_hook + style + non-empty pages')
      }
      // Planning summary echoed back to the user
      const lines = pages.map((p: Record<string, unknown>, i: number) => {
        const q =
          Array.isArray(p.image_queries) && p.image_queries.length
            ? ` [images: ${p.image_queries.length}]`
            : ''
        return `Page ${i + 1} [${String(p.layout ?? '')}] ${String(p.title ?? '')} — ${String(p.brief ?? '').slice(0, 40)}${q}`
      })
      if (state) {
        state.plannedPages = pages.length
        state.plannedTitles = pages.map(
          (p: Record<string, unknown>) => String(p.title ?? '').trim() || 'Untitled',
        )
        state.pageDone = new Array(pages.length).fill(false) // New planning round, reset per-page progress
      }
      const summary = t('aiSumPlan', { count: pages.length, hook: coreHook })
      return {
        output: `Plan confirmed:\nCore Hook: ${coreHook}\nStyle: ${style}\n${lines.join('\n')}\nNow follow this plan and call generate_deck once, passing core_hook + style + all ${pages.length} pages (each page's brief strictly following the plan above). Each turn a <generation-progress> note tells you how many pages remain; do not stop before they are complete.`,
        mutated: false,
        summary,
      }
    }

    case 'regenerate_slide': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailRegen'), `slideIndex out of range (0-${slides.length - 1})`)
      const regenUseCloud =
        !!access.generatePageCloud && !!(await access.isCloudPageGenEnabled?.().catch(() => false))
      if (!access.regenerateSlide || (!regenUseCloud && !access.generatePageLocal))
        return fail(
          t('aiFailRegen'),
          'The current environment does not support the page-redo pipeline',
        )
      const brief = String(call.input.brief ?? '').trim()
      if (!brief) return fail(t('aiFailRegen'), 'brief must not be empty')
      // Figure-provenance gate
      if (countSpecificFigures(`${String(call.input.title ?? '')}\n${brief}`) >= 2) {
        const gateErr = dataSourceGateError(call, state)
        if (gateErr) return fail(t('aiFailRegen'), gateErr)
      }
      const regenImages = Array.isArray(call.input.image_urls)
        ? (call.input.image_urls as unknown[]).map(String).filter((u) => /^https?:\/\//.test(u))
        : []
      // One retry then give up (same semantics as generate_deck pages). Both paths return a
      // marker pointing at a one-slide pptx temp file; landing is shared.
      const backoff = access.retryBackoffMs ?? 2000
      let marker: string | null = null
      let genImageFails: string[] = []
      let lastErr = ''
      const regenArgs = {
        pageIndex: idx + 1,
        totalPages: slides.length,
        coreHook: '',
        style: state?.lastStyleSkill ?? '',
        title: String(call.input.title ?? ''),
        brief,
        layout: String(call.input.layout ?? ''),
        images: regenImages,
        canvasW: 1280,
        canvasH: 720,
      }
      const regenGen = regenUseCloud ? access.generatePageCloud! : access.generatePageLocal!
      for (let attempt = 0; attempt < 2 && !marker; attempt++) {
        if (attempt > 0 && backoff > 0) await new Promise((r) => setTimeout(r, backoff))
        const res = await regenGen(regenArgs)
        if (res.ok && res.marker) {
          marker = res.marker
          if ('imageFailures' in res && Array.isArray(res.imageFailures))
            genImageFails = res.imageFailures
        } else lastErr = res.error ?? t('aiErrUnknown')
      }
      if (!marker)
        return fail(
          t('aiFailRegen'),
          `Page generation failed (2 attempts): ${lastErr}. This is usually a temporary service error — do not keep calling regenerate_slide in a loop. Instead, make the requested changes in place with execute_slide_script / set_element_* (group children are editable too), or tell the user to retry in a few minutes. The page was not modified.`,
        )
      const r = signal
        ? await access.regenerateSlide(idx, marker, signal)
        : await access.regenerateSlide(idx, marker)
      if (!r.ok)
        return fail(
          t('aiFailRegen'),
          `${r.error || 'Redo failed'} (the page was not modified; retry once, or edit it in place with execute_slide_script)`,
        )
      if (state) state.htmlGenerated = true
      const allImageFails = [
        ...(r.imageFailures ?? []),
        ...genImageFails.map((url) => ({ page: idx + 1, url })),
      ]
      return {
        output:
          `Redid page ${idx + 1} in place from the brief (other pages untouched; the user can undo). Fine-tune afterwards with execute_slide_script / set_element_* tools.` +
          imageFailNote(allImageFails.length ? allImageFails : undefined),
        mutated: true,
        summary: t('aiSumRegen', { n: idx + 1 }),
      }
    }

    case 'delete_slide': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailDeleteSlide'), `slideIndex out of range (0-${slides.length - 1})`)
      if (slides.length <= 1)
        return fail(t('aiFailDeleteSlide'), 'Only one page remains; cannot delete')
      const r = await window.slidesApi.deleteSlide(idx)
      if (!r) return fail(t('aiFailDeleteSlide'), 'Deletion failed')
      access.applyDeck(r, Math.max(0, Math.min(idx, r.length - 1)))
      return {
        output: `Deleted page ${idx + 1}; the deck now has ${r.length} pages. Note that slideIndex of pages after it shifted down by 1.`,
        mutated: true,
        summary: t('aiSumDeleteSlide', { n: idx + 1 }),
      }
    }

    case 'generate_deck': {
      // ── Self-driven pipeline:
      //   1) Plan: use pages if passed; with topic, the tool plans the outline via LLM (batched recursion over threshold) — fixes missing pages at the input side.
      //   2) Generate: batched concurrent page generation (one retry per page), **each batch lands immediately → frontend shows pages one by one**.
      //      Cloud (gsk slide_generate) when available; otherwise fully local — the LLM (app AI
      //      transport, works with BYOK) writes a slide spec that is built directly into a pptx.
      const useCloud =
        !!access.generatePageCloud && !!(await access.isCloudPageGenEnabled?.().catch(() => false))
      if (!useCloud && !access.generatePageLocal)
        return fail(
          t('aiFailGenDeck'),
          'No page generation pipeline is available in this environment',
        )
      if (!access.landGeneratedPages)
        return fail(
          t('aiFailGenDeck'),
          'The current environment does not support the page landing pipeline',
        )

      // Hard gate: with unread text attachments present, refuse to generate.
      // The prompt already demands reading them first, but prompt rules alone are not
      // enforcement — this check is, and it is fully computable from the tool-call history.
      {
        const unread = access.unreadTextAttachments?.() ?? []
        if (unread.length > 0) {
          return fail(
            t('aiFailGenDeck'),
            `Text attachment(s) not read yet: ${unread.join(', ')}. Read each one with read_attachment first (paginate long files), then call generate_deck again and pass the key facts you read (names, figures, deals, next steps) in the context argument — deck content must come from the attachments, not generic filler.`,
          )
        }
      }

      const canvasW = 1280
      const canvasH = 720
      const insertMode: 'replace' | 'append' =
        call.input.insert_mode === 'append' ? 'append' : 'replace'
      const PLAN_BATCH = 12 // Per-batch planning cap (kept slightly conservative against truncation)
      const GEN_BATCH = 2 // Per-page generation concurrency (opus large output + proxy concurrent streams time out easily; lowered to 2, stability first)
      const BACKOFF_MS = access.retryBackoffMs ?? 2000 // Retry backoff base (rate limits/overload are mostly transient; immediate retries would hit them again)
      const landGeneratedPages = signal
        ? (
            markers: string[],
            mode: 'replace' | 'append' | 'insert_at',
            deckName?: string,
            insertAt?: number,
          ) => access.landGeneratedPages!(markers, mode, deckName, insertAt, signal)
        : access.landGeneratedPages!

      let coreHook = String(call.input.core_hook ?? '').trim()
      const style = String(call.input.style ?? '').trim()
      const pages: Array<Record<string, unknown>> = Array.isArray(call.input.pages)
        ? (call.input.pages as Array<Record<string, unknown>>)
        : []
      const topic = String(call.input.topic ?? '').trim()
      const context = String(call.input.context ?? '').trim() || undefined
      // Every per-page request re-sends the context; cap it so N pages don't multiply a huge attachment
      const PAGE_CONTEXT_MAX = 8000
      const pageContext =
        context && context.length > PAGE_CONTEXT_MAX ? context.slice(0, PAGE_CONTEXT_MAX) : context
      const styleTemplateName = String(call.input.style_template ?? '').trim() || undefined

      // Figure-provenance gate: a data-dense request must say where its numbers came from
      {
        const briefText = [
          topic,
          context ?? '',
          ...pages.map((p) => `${String(p.title ?? '')} ${String(p.brief ?? '')}`),
        ].join('\n')
        if (countSpecificFigures(briefText) >= 2) {
          const gateErr = dataSourceGateError(call, state)
          if (gateErr) return fail(t('aiFailGenDeck'), gateErr)
        }
      }

      // ── Step 0: generate the Style Skill independently — one focused LLM call thinking only about the design system, less AI-looking.
      // Prefer the user-passed style as the style preference; without pages, generate a full Style Skill from topic.
      // When full pages+style are passed, respect the user's style (don't regenerate).
      // When style_template is passed, load the template directly and skip Step 0 (no LLM style generation).
      let styleSkill = ''
      if (styleTemplateName && access.loadStyleTemplate) {
        // Preferred: load from a saved template (fail-open: on load failure continue normal generation)
        try {
          const tr = await access.loadStyleTemplate(styleTemplateName)
          if (tr.ok && tr.styleSkill) styleSkill = tr.styleSkill
        } catch {
          /* fail-open */
        }
      }
      // User clicked stop → checked inside each stage loop, abort as soon as possible (pages already landed are kept)
      const cancelled = () => signal?.aborted === true
      const cancelResult = (landed: number, totalPages: number) => ({
        output: `The user stopped generation. ${landed} page(s) already landed${totalPages ? ` (${totalPages} planned)` : ''} and remain on the canvas.`,
        mutated: landed > 0,
        summary: landed > 0 ? t('aiSumStoppedKept', { n: landed }) : t('aiErrStopped'),
      })
      if (cancelled()) return cancelResult(0, 0)

      const needStyleGen =
        !styleSkill && access.generateStyleSkill && (topic || pages.length === 0 || !style)
      if (needStyleGen) {
        access.onProgress?.({
          stage: 'style',
          label: t('aiStageStyle'),
          status: 'running',
          summary: t('aiStageStyleRunning'),
        })
        const styleTopic =
          topic || coreHook || (pages[0] ? String(pages[0].title ?? '') : 'Presentation')
        const sr = await access.generateStyleSkill!({
          topic: styleTopic,
          ...(style ? { styleHint: style } : {}),
          ...(context ? { questionnaire: context } : {}),
          ...(signal ? { signal } : {}),
        })
        if (sr.ok && sr.styleSkill) styleSkill = sr.styleSkill
        access.onProgress?.({
          stage: 'style',
          label: t('aiStageStyle'),
          status: 'done',
          summary: t('aiStageStyleDone'),
        })
      }
      if (!styleSkill) styleSkill = style // Fallback: use the user-passed style, or empty

      // ── Step 1: plan the outline — without pages, plan in-tool from topic (batched recursion over PLAN_BATCH; layouts chosen per the Style Skill).
      const approxForProgress = Math.max(
        1,
        parseInt(String(call.input.approx_pages ?? '0'), 10) || pages.length || 1,
      )
      if (pages.length === 0) {
        const approx = approxForProgress
        if (!topic || !approx) {
          return fail(
            t('aiFailGenDeck'),
            'generate_deck requires [topic + approx_pages] (system plans internally), or pass [core_hook + style + pages] directly.',
          )
        }
        if (!access.planDeckOutline)
          return fail(
            t('aiFailGenDeck'),
            'The current environment does not support internal planning; pass pages directly.',
          )
        access.onProgress?.({
          stage: 'plan',
          label: t('aiStagePlan'),
          done: 0,
          total: approx,
          status: 'running',
          summary: t('aiStagePlanRunning'),
        })
        let planned = 0
        while (planned < approx) {
          if (cancelled()) return cancelResult(0, approx)
          const count = Math.min(PLAN_BATCH, approx - planned)
          const r = await access.planDeckOutline({
            topic,
            count,
            startPage: planned + 1,
            ...(context ? { context } : {}),
            ...(styleSkill ? { styleSkill } : {}),
            ...(planned > 0 && coreHook ? { continueFrom: { coreHook } } : {}),
            ...(signal ? { signal } : {}),
          })
          if (
            !r.ok ||
            !r.outline ||
            !Array.isArray(r.outline.pages) ||
            r.outline.pages.length === 0
          ) {
            if (pages.length === 0) {
              // On failure the progress must be finalized, otherwise the UI spins forever at "Planning outline…"
              access.onProgress?.({
                stage: 'plan',
                label: t('aiStagePlan'),
                done: 0,
                total: approx,
                status: 'error',
                summary: t('aiStagePlanFailed'),
              })
              return fail(t('aiFailGenDeck'), `Planning failed: ${r.error || 'outline is empty'}`)
            }
            break // A later planning batch failed; at least generate what was already planned
          }
          if (planned === 0) {
            coreHook = String(r.outline.core_hook ?? coreHook).trim()
          }
          pages.push(...r.outline.pages)
          planned += r.outline.pages.length
          access.onProgress?.({
            stage: 'plan',
            label: t('aiStagePlan'),
            done: planned,
            total: approx,
            status: 'running',
            summary: t('aiStagePlanProgress', { done: planned, total: approx }),
          })
          if (r.outline.pages.length < count) break // The model returned fewer than requested; stop
        }
        access.onProgress?.({
          stage: 'plan',
          label: t('aiStagePlan'),
          done: pages.length,
          total: pages.length,
          status: 'done',
          summary: t('aiStagePlanDone', { n: pages.length }),
        })
      }

      // ── Step 1.5: in-tool image search —
      // walk every page's image_queries and replace "English keywords (non-URL)" with real image URLs.
      // Entries that are already http(s) URLs are respected upstream, not re-searched; pages whose search failed keep an empty array (fail-open).
      // The same keyword is searched once per deck (fetching several candidates at once); allocation skips already-used URLs to avoid duplicate images across pages.
      if (access.searchImages) {
        const isUrl = (s: string) => /^https?:\/\//i.test(s)
        const normKw = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')
        // Collect deduplicated search keywords across the deck
        const uniqueKeywords: string[] = []
        const seenKw = new Set<string>()
        for (const p of pages) {
          if (!Array.isArray(p.image_queries)) continue
          for (const q of p.image_queries as unknown[]) {
            const s = String(q).trim()
            if (!s || isUrl(s)) continue
            const k = normKw(s)
            if (!seenKw.has(k)) {
              seenKw.add(k)
              uniqueKeywords.push(s)
            }
          }
        }
        // Each keyword is searched only once, fetching several candidates so cross-page dedup can pick unused images
        const candidatesByKw = new Map<string, string[]>()
        const totalSearches = uniqueKeywords.length
        if (totalSearches > 0) {
          access.onProgress?.({
            stage: 'images',
            label: t('aiStageImages'),
            done: 0,
            total: totalSearches,
            status: 'running',
            summary: t('aiStageImagesRunning', { done: 0, total: totalSearches }),
          })
          let imagesDone = 0
          await Promise.all(
            uniqueKeywords.map(async (kw) => {
              if (cancelled()) return
              try {
                const urls = await access.searchImages!(kw, 5)
                candidatesByKw.set(normKw(kw), urls)
              } catch {
                /* fail-open */
              }
              imagesDone++
              access.onProgress?.({
                stage: 'images',
                label: t('aiStageImages'),
                done: imagesDone,
                total: totalSearches,
                status: 'running',
                summary: t('aiStageImagesRunning', { done: imagesDone, total: totalSearches }),
              })
            }),
          )
        }
        // Allocate page by page in order: explicit URLs are kept as-is (and counted as used); keywords pick from candidates, preferring images the deck hasn't used yet
        const usedUrls = new Set<string>()
        for (const p of pages) {
          if (!Array.isArray(p.image_queries)) continue
          for (const q of p.image_queries as unknown[]) {
            const s = String(q).trim()
            if (isUrl(s)) usedUrls.add(s)
          }
        }
        for (const p of pages) {
          if (!Array.isArray(p.image_queries) || p.image_queries.length === 0) continue
          const resolvedUrls: string[] = []
          for (const q of p.image_queries as unknown[]) {
            const s = String(q).trim()
            if (!s) continue
            if (isUrl(s)) {
              resolvedUrls.push(s)
              continue
            }
            const candidates = candidatesByKw.get(normKw(s)) ?? []
            // If all candidates are used, fall back to reusing the first one (an image beats no image)
            const pick = candidates.find((u) => !usedUrls.has(u)) ?? candidates[0]
            if (pick) {
              usedUrls.add(pick)
              resolvedUrls.push(pick)
            }
          }
          p.image_queries = resolvedUrls
        }
        if (totalSearches > 0) {
          access.onProgress?.({
            stage: 'images',
            label: t('aiStageImages'),
            done: totalSearches,
            total: totalSearches,
            status: 'done',
            summary: t('aiStageImagesDone', { n: totalSearches }),
          })
        }
      }

      if (!coreHook) coreHook = topic || 'Presentation'
      if (!styleSkill)
        styleSkill =
          'Unified clean modern style: main background #FFFFFF, main text #1A1A2E, primary accent #2563EB, secondary accent #F59E0B, cards #F8FAFC, borders #E2E8F0; sans-serif fonts; titles 40-56px, body 16-20px'
      const total = pages.length
      if (total === 0) return fail(t('aiFailGenDeck'), 'No pages to generate (the plan is empty).')

      // Store the plan in the progress state (shared with the todolist mechanism; buildContext injects it every turn)
      // Also record styleSkill+topic for the save_style_template tool
      if (state) {
        state.plannedPages = total
        state.plannedTitles = pages.map((p) => String(p.title ?? '').trim() || 'Untitled')
        state.pageDone = new Array(total).fill(false)
        state.lastStyleSkill = styleSkill
        state.lastTopic = topic || coreHook || ''
      }

      // Presentation name: prefer the cover (page 1) title, then the user-entered topic / coreHook.
      // New drafts are saved under this name instead of "Untitled-timestamp".
      const deckName = String(pages[0]?.title ?? '').trim() || topic || coreHook

      // ── Step 2: generate page by page + land as we go (frontend shows pages one by one).
      // Cloud (gsk slide_generate) and local (LLM spec → pptx-engine build) both produce a
      // one-slide pptx temp file; genOne returns its marker and landing reads the bytes.
      // Land strictly in page order: nextToLand pointer; a page lands only when its marker is ready, keeping page order intact.
      const markerByIndex: (string | null)[] = new Array(total).fill(null)
      // Per-page completion flags (aligned with pages; same reference as state.pageDone, used by buildContext progress injection)
      const doneFlags: boolean[] = state?.pageDone ?? new Array(total).fill(false)
      const genFailed: number[] = [] // Page indexes (0-based) whose page generation failed
      const landFailed: number[] = [] // Page indexes (0-based) whose HTML generated but conversion/landing failed
      const degraded: number[] = [] // Page indexes (0-based) that "landed" via the plain-text fallback — must be reported, otherwise dead pages appear silently
      const deckImageFails: { page: number; url: string }[] = [] // Image download/conversion failures (page numbers are deck-global 1-based)
      const pageErrors: (string | undefined)[] = new Array(total).fill(undefined) // Last failure reason per page
      let landedPages = 0
      let firstDone = false
      let baseOffset = 0 // Number of existing pages before generated page 0 in the deck (>0 in append mode); used to re-insert retries at their original position
      let nextToLand = 0 // Index of the next page to land (0-based)

      // Initialize per-page progress state (all pages pending)
      const pageProgressItems: PageProgressItem[] = pages.map((p) => ({
        title: String(p.title ?? '').trim() || t('aiPageN', { n: pages.indexOf(p) + 1 }),
        status: 'pending',
      }))

      // Send initial pages progress
      access.onProgress?.({
        stage: 'pages',
        label: t('aiStagePages'),
        done: 0,
        total,
        status: 'running',
        summary: t('aiStagePageRunning', { n: 1, total }),
        pages: [...pageProgressItems],
      })

      const genOne = async (p: Record<string, unknown>, pageIndex: number) => {
        // Mark as running
        pageProgressItems[pageIndex - 1] = {
          ...pageProgressItems[pageIndex - 1]!,
          status: 'running',
        }
        access.onProgress?.({
          stage: 'pages',
          label: t('aiStagePages'),
          done: landedPages,
          total,
          status: 'running',
          summary: t('aiStagePageRunning', { n: pageIndex, total }),
          pages: [...pageProgressItems],
        })
        const images = Array.isArray(p.image_queries)
          ? (p.image_queries as unknown[])
              .map((x) => String(x))
              .filter((x) => /^https?:\/\//.test(x))
          : []
        let lastErr = ''
        const pageArgs = {
          pageIndex,
          totalPages: total,
          coreHook,
          style: styleSkill,
          title: String(p.title ?? ''),
          brief: String(p.brief ?? ''),
          layout: String(p.layout ?? ''),
          images,
          ...(pageContext ? { context: pageContext } : {}),
          ...(topic ? { topic } : {}),
          canvasW,
          canvasH,
          ...(signal ? { signal } : {}),
        }
        // Both paths return a marker pointing at a one-slide pptx temp file. One retry, then the
        // page is skipped for now (locally-failed pages get one more chance in the retry round)
        // and the rest of the deck keeps generating.
        const gen = useCloud ? access.generatePageCloud! : access.generatePageLocal!
        for (let attempt = 0; attempt < 2; attempt++) {
          if (cancelled()) return null
          if (attempt > 0 && BACKOFF_MS > 0) await new Promise((r) => setTimeout(r, BACKOFF_MS))
          const res = await gen(pageArgs)
          if (res.ok && res.marker) {
            pageErrors[pageIndex - 1] = undefined
            if ('imageFailures' in res && Array.isArray(res.imageFailures))
              deckImageFails.push(...res.imageFailures.map((url) => ({ page: pageIndex, url })))
            return res.marker
          }
          lastErr = res.error ?? t('aiErrUnknown')
        }
        pageErrors[pageIndex - 1] = lastErr
        return null
      }

      // Land in page order: starting from nextToLand, land as many as possible (stop at a gap and wait for it to generate).
      const flushLanded = async () => {
        while (nextToLand < total && markerByIndex[nextToLand] !== null) {
          if (cancelled()) return
          const marker = markerByIndex[nextToLand] as string
          if (marker.length > 0) {
            const m: 'replace' | 'append' = firstDone ? 'append' : insertMode
            const r = await landGeneratedPages([marker], m, deckName)
            if (r.ok) {
              if (r.fallbackReason) {
                degraded.push(nextToLand)
                pageErrors[nextToLand] = r.fallbackReason
              }
              if (r.imageFailures) deckImageFails.push(...r.imageFailures)
              if (!firstDone) baseOffset = r.appendedFrom ?? 0
              landedPages += 1
              firstDone = true
              doneFlags[nextToLand] = true
              pageProgressItems[nextToLand] = { ...pageProgressItems[nextToLand]!, status: 'done' }
              access.onProgress?.({
                stage: 'pages',
                label: t('aiStagePages'),
                done: landedPages,
                total,
                status: 'running',
                summary:
                  landedPages < total
                    ? t('aiStagePageRunning', { n: landedPages + 1, total })
                    : t('aiStageFinishing'),
                pages: [...pageProgressItems],
              })
            } else {
              landFailed.push(nextToLand)
              pageErrors[nextToLand] = t('aiErrLandFailed', { err: r.error ?? t('aiErrUnknown') })
              pageProgressItems[nextToLand] = {
                ...pageProgressItems[nextToLand]!,
                status: 'error',
                error: pageErrors[nextToLand],
              }
            }
          }
          nextToLand += 1
        }
      }

      for (let start = 0; start < total; start += GEN_BATCH) {
        if (cancelled()) break
        const batchIdxs = []
        for (let k = start; k < Math.min(start + GEN_BATCH, total); k++) batchIdxs.push(k)
        const results = await Promise.all(
          batchIdxs.map(async (idx) => ({ idx, marker: await genOne(pages[idx], idx + 1) })),
        )
        if (cancelled()) break
        for (const { idx, marker } of results) {
          if (marker && marker.length > 0) {
            markerByIndex[idx] = marker
          } else {
            markerByIndex[idx] = '' // Empty-string placeholder; doesn't block subsequent landings
            genFailed.push(idx)
            pageProgressItems[idx] = {
              ...pageProgressItems[idx]!,
              status: 'error',
              error: pageErrors[idx],
            }
          }
        }
        // Batch generated → immediately land everything that can land (frontend shows pages one by one)
        await flushLanded()
      }
      if (!cancelled()) await flushLanded() // Finalize

      // ── One retry round for failed pages, re-inserted at their original page position with
      //   insert_at (target position = existing-page offset + pages completed before this one).
      //   Landing-failed pages re-land (cheap: the one-slide pptx already exists). Cloud
      //   generation-failed pages already spent their single retry and stay skipped; local
      //   generation-failed pages get one more generation attempt here (LLM calls are the
      //   user's own quota, and a JSON spec retry is cheap).
      if (!cancelled()) {
        const retryIdxs = [...new Set([...(useCloud ? [] : genFailed), ...landFailed])].sort(
          (a, b) => a - b,
        )
        for (const idx of retryIdxs) {
          if (cancelled()) break
          let marker = markerByIndex[idx]
          if (!marker && !useCloud) marker = await genOne(pages[idx]!, idx + 1)
          if (!marker) {
            pageProgressItems[idx] = {
              ...pageProgressItems[idx]!,
              status: 'error',
              error: pageErrors[idx],
            }
            continue
          }
          const isFirstLand = !firstDone
          const r = isFirstLand
            ? await landGeneratedPages([marker], insertMode, deckName)
            : await landGeneratedPages(
                [marker],
                'insert_at',
                deckName,
                baseOffset + doneFlags.slice(0, idx).filter(Boolean).length,
              )
          if (r.ok) {
            if (isFirstLand) {
              baseOffset = r.appendedFrom ?? 0
              firstDone = true
            }
            landedPages += 1
            doneFlags[idx] = true
            pageErrors[idx] = r.fallbackReason
            if (r.fallbackReason) degraded.push(idx)
            if (r.imageFailures) deckImageFails.push(...r.imageFailures)
            pageProgressItems[idx] = {
              ...pageProgressItems[idx]!,
              status: 'done',
              error: undefined,
            }
            access.onProgress?.({
              stage: 'pages',
              label: t('aiStagePages'),
              done: landedPages,
              total,
              status: 'running',
              summary: t('aiStagePageRestored', { n: idx + 1 }),
              pages: [...pageProgressItems],
            })
          } else {
            pageErrors[idx] = t('aiErrReinsertFailed', { err: r.error ?? t('aiErrUnknown') })
            pageProgressItems[idx] = {
              ...pageProgressItems[idx]!,
              status: 'error',
              error: pageErrors[idx],
            }
          }
        }
      }

      // User stopped midway: keep landed pages and finish honestly (no more retries / no failed-page reporting)
      if (cancelled()) {
        if (state) state.htmlGenerated = landedPages > 0 || state.htmlGenerated
        access.onProgress?.({
          stage: 'done',
          total: landedPages,
          summary: t('aiSumStoppedKept', { n: landedPages }),
        })
        return cancelResult(landedPages, total)
      }

      if (state) state.htmlGenerated = true

      // ── Sidecar persistence (fail-open): write styleSkill to .styleskill.json next to the draft
      if (landedPages > 0 && access.saveSidecar && styleSkill) {
        try {
          await access.saveSidecar({
            topic: topic || coreHook || '',
            styleSkill,
            createdAt: new Date().toISOString(),
          })
        } catch {
          /* fail-open: a sidecar failure doesn't block */
        }
      }

      if (landedPages === 0) {
        access.onProgress?.({
          stage: 'done',
          total: 0,
          summary: t('aiStageAllFailed', { n: total }),
        })
        return fail(
          t('aiFailGenDeck'),
          `All ${total} pages failed to generate; retry or check the AI model configuration.`,
        )
      }

      // Send completion progress event
      access.onProgress?.({
        stage: 'done',
        total: landedPages,
        summary: t('aiStageDoneSummary', { n: landedPages }),
      })

      const note = buildProgressNote(state)
      const progressTail = note ? `\n${note}` : ''
      // Faithfully report all unfinished pages (both HTML generation failures and conversion/landing failures; all already retried once)
      const stillFailed: number[] = []
      for (let i = 0; i < total; i++) if (!doneFlags[i]) stillFailed.push(i + 1)
      const briefErr = (s?: string) => (s ? (s.length > 80 ? `${s.slice(0, 80)}…` : s) : '')
      const okMsg = `Self-driven generation produced ${landedPages}/${total} pages (HTML written page by page, displayed as generated; failed pages were auto-retried).`
      const failDetail = stillFailed
        .map((n) => `page ${n}${pageErrors[n - 1] ? ` (${briefErr(pageErrors[n - 1])})` : ''}`)
        .join(', ')
      const failMsg = stillFailed.length
        ? ` ⚠️ ${failDetail} still failed after retry (these pages are missing from the deck; later pages shifted forward). To fill them in, call generate_deck again with briefs for just those pages and insert_mode:"append", and tell the user the page is at the end.`
        : ' Fine-tune with the set_element_* / add_* tools.'
      // Pages that went through the plain-text fallback: the page exists in the deck but all design is lost; the model must be told explicitly to redo it in place, not silently treat it as success
      const degradedMsg = degraded.length
        ? ` ⚠️ ${[...degraded]
            .sort((a, b) => a - b)
            .map(
              (i) =>
                `page ${i + 1} (canvas slideIndex=${baseOffset + doneFlags.slice(0, i).filter(Boolean).length})`,
            )
            .join(
              ', ',
            )} degraded to a plain-text fallback page after conversion failure (all layout and styling lost): immediately redo these pages in place with regenerate_slide following the original brief, then reply to the user.`
        : ''
      return {
        output: okMsg + failMsg + degradedMsg + imageFailNote(deckImageFails) + progressTail,
        mutated: true,
        summary: t('aiSumDeckGenerated', { done: landedPages, total }),
      }
    }

    case 'add_slide': {
      const src = Number(call.input.sourceIndex)
      if (!slides[src])
        return fail(t('aiFailNewSlide'), `sourceIndex out of range (0-${slides.length - 1})`)
      const r = await window.slidesApi.addSlide({
        sourceIndex: src,
        clearText: call.input.clearText !== false,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r) return fail(t('aiFailNewSlide'), 'Creation failed')
      access.applyDeck(r.slides, r.index)
      return {
        output: `Created page ${r.index + 1} (${r.slides.length} pages total). ✅ Use slideIndex=${r.index} when filling content into this new page (not 1, unless it happens to be 1). To add another page after it, use sourceIndex=${r.slides.length - 1} (current last page) so it appends at the end.`,
        mutated: true,
        summary: t('aiSumNewSlide', { n: r.index + 1 }),
      }
    }

    case 'add_text_box':
    case 'add_shape': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailNewElement'), `slideIndex out of range (0-${slides.length - 1})`)
      const scratchBlock = blockScratchBuild(call.name, slides, state)
      if (scratchBlock) return scratchBlock
      const isShape = call.name === 'add_shape'
      const paragraphs = toEditParagraphs(call.input.paragraphs)
      if (!isShape && !paragraphs)
        return fail(t('aiFailNewTextbox'), 'paragraphs must be a non-empty array')
      const kind = isShape ? String(call.input.kind) : 'textbox'
      if (isShape && !/^[a-zA-Z][a-zA-Z0-9]*$/.test(kind)) {
        return fail(t('aiFailNewShape'), `Invalid shape name: ${kind}`)
      }
      const r = await window.slidesApi.addElement({
        slideIndex: idx,
        kind,
        xPx: Number(call.input.x),
        yPx: Number(call.input.y),
        wPx: Number(call.input.w),
        hPx: Number(call.input.h),
        fitWidthPx: access.fitWidthPx,
        ...(paragraphs ? { paragraphs } : {}),
        ...(isShape && call.input.fillColor ? { fillColor: String(call.input.fillColor) } : {}),
      })
      if (!r) return fail(t('aiFailNewElement'), 'Insertion failed')
      access.applySlide(idx, r.slide)
      return {
        output: `Created a new ${isShape ? 'shape' : 'text box'} on page ${idx + 1}, element id=${r.sourceId}.`,
        mutated: true,
        summary: isShape
          ? t('aiSumNewShape', { n: idx + 1 })
          : t('aiSumNewTextbox', { n: idx + 1 }),
      }
    }

    case 'set_slide_size': {
      const widthMm = Number(call.input.widthMm)
      const heightMm = Number(call.input.heightMm)
      if (!(widthMm > 10 && widthMm < 2000) || !(heightMm > 10 && heightMm < 2000))
        return fail(t('aiFailNewElement'), 'widthMm/heightMm must be within 10–2000mm')
      const EMU_PER_MM = 36000
      const r = await window.slidesApi.setSlideSize({
        cx: Math.round(widthMm * EMU_PER_MM),
        cy: Math.round(heightMm * EMU_PER_MM),
      })
      if (!r) return fail(t('aiFailNewElement'), 'Slide size change failed')
      access.applyDeck(r)
      return {
        output: `Canvas is now ${widthMm}×${heightMm}mm (${r.length} pages rescaled). All later coordinates are pixels on this new canvas size.`,
        mutated: true,
        summary: t('aiSumNewShape', { n: 1 }),
      }
    }

    case 'add_connector': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailNewElement'), `slideIndex out of range (0-${slides.length - 1})`)
      const fromId = String(call.input.fromId ?? '')
      const toId = String(call.input.toId ?? '')
      if (!fromId || !toId) return fail(t('aiFailNewElement'), 'fromId and toId are required')
      if (fromId === toId) return fail(t('aiFailNewElement'), 'fromId and toId must differ')
      const from = findNodeById(slide.nodes, fromId)
      const to = findNodeById(slide.nodes, toId)
      if (!from?.box || !to?.box)
        return fail(t('aiFailNewElement'), `fromId/toId not found on page ${idx + 1}`)
      const fromCenter = { x: from.box.x + from.box.w / 2, y: from.box.y + from.box.h / 2 }
      const toCenter = { x: to.box.x + to.box.w / 2, y: to.box.y + to.box.h / 2 }
      const horizontal = Math.abs(toCenter.x - fromCenter.x) >= Math.abs(toCenter.y - fromCenter.y)
      const start = horizontal
        ? toCenter.x >= fromCenter.x
          ? { x: from.box.x + from.box.w, y: fromCenter.y, idx: 3 }
          : { x: from.box.x, y: fromCenter.y, idx: 1 }
        : toCenter.y >= fromCenter.y
          ? { x: fromCenter.x, y: from.box.y + from.box.h, idx: 2 }
          : { x: fromCenter.x, y: from.box.y, idx: 0 }
      const end = horizontal
        ? toCenter.x >= fromCenter.x
          ? { x: to.box.x, y: toCenter.y, idx: 1 }
          : { x: to.box.x + to.box.w, y: toCenter.y, idx: 3 }
        : toCenter.y >= fromCenter.y
          ? { x: toCenter.x, y: to.box.y, idx: 0 }
          : { x: toCenter.x, y: to.box.y + to.box.h, idx: 2 }
      const x1 = start.x
      const y1 = start.y
      const x2 = end.x
      const y2 = end.y
      const preset =
        call.input.kind === 'elbow'
          ? 'bentConnector3'
          : call.input.kind === 'curved'
            ? 'curvedConnector3'
            : 'line'
      const r = await window.slidesApi.addElement({
        slideIndex: idx,
        kind: preset,
        xPx: Math.min(x1, x2),
        yPx: Math.min(y1, y2),
        wPx: Math.max(Math.abs(x2 - x1), 1),
        hPx: Math.max(Math.abs(y2 - y1), 1),
        fitWidthPx: access.fitWidthPx,
        stroke: {
          color: String(call.input.color ?? '#687784'),
          widthPt: Number(call.input.widthPt) || 1.5,
        },
      })
      if (!r) return fail(t('aiFailNewElement'), 'Connector insertion failed')
      access.applySlide(idx, r.slide)
      let bound = false
      try {
        const boundSlide = await window.slidesApi.editConnectorEndpoints({
          slideIndex: idx,
          sourceId: r.sourceId,
          x1Px: x1,
          y1Px: y1,
          x2Px: x2,
          y2Px: y2,
          fitWidthPx: access.fitWidthPx,
          start: { targetId: fromId, idx: start.idx },
          end: { targetId: toId, idx: end.idx },
        })
        if (boundSlide) {
          access.applySlide(idx, boundSlide)
          bound = true
        }
      } catch {
        // Degrade gracefully: keep the unbound line (still visible and movable).
      }
      return {
        output: `Drew a ${String(call.input.kind ?? 'straight')} connector (id=${r.sourceId}) from ${fromId} to ${toId}${bound ? '; endpoints bound so it follows later moves' : ''}.`,
        mutated: true,
        summary: t('aiSumNewShape', { n: idx + 1 }),
      }
    }

    case 'create_research_figure': {
      // Graceful degradation: agents (especially weak models) frequently pass a
      // stale slideIndex after deleting/creating canvases. Fall back to the
      // current slide instead of failing the whole creation.
      let idx = Number(call.input.slideIndex)
      if (!slides[idx]) idx = access.getCurrent()
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailNewElement'), `slideIndex out of range (0-${slides.length - 1})`)
      if (mode !== 'research') {
        return fail(
          t('aiFailNewElement'),
          'create_research_figure runs in Research Figure Mode only',
        )
      }
      if (!access.runLlm) return fail(t('aiFailNewElement'), 'LLM transport unavailable')
      const thesis = String(call.input.thesis ?? '').trim()
      if (!thesis) return fail(t('aiFailNewElement'), 'thesis is required')
      const notes = String(call.input.notes ?? '').trim()
      const parseJson = (text: string): unknown => {
        const fenced = /```(?:json)?\\s*([\\s\\S]*?)```/.exec(text)
        const raw = (fenced ? fenced[1]! : text).trim()
        const start = raw.indexOf('{')
        const end = raw.lastIndexOf('}')
        return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw)
      }
      const plannerUser = [
        'Canvas: ' + slide.widthPx + 'x' + slide.heightPx + 'px (px, origin top-left)',
        'Request: ' + thesis,
        notes ? 'Material notes:\\n' + notes : '',
      ]
        .filter(Boolean)
        .join('\\n')
      const llm = {
        semanticPlan: async (_thesis: string, feedback?: string) => {
          const r = await access.runLlm!(
            effectivePrompt('research.semantic-planner', RESEARCH_SEMANTIC_PLANNER_PROMPT),
            feedback
              ? plannerUser +
                  '\\n\\nPrevious attempt rejected by schema validation: ' +
                  feedback +
                  '\\nFix the issues and output the JSON object again.'
              : plannerUser,
          )
          if (!r.ok) throw new Error(r.error ?? 'planner call failed')
          return parseJson(r.text ?? '')
        },
        compose: async (ctx: {
          plan: unknown
          measured: Array<{ id: string; w: number; h: number }>
          canvas: { w: number; h: number }
          autonomy: string
          critique?: string[]
        }) => {
          const r = await access.runLlm!(
            effectivePrompt('research.composition-designer', RESEARCH_COMPOSITION_DESIGNER_PROMPT),
            JSON.stringify(ctx),
          )
          if (!r.ok) return null
          try {
            return parseJson(r.text ?? '')
          } catch {
            return null
          }
        },
      }
      // P0.5 contract bridge: the structured contract field is authoritative;
      // legacy top-level fields (domain/figureFamily/venue/outputContext) are
      // normalized into the same FigureContract for backward compatibility.
      const contractInput =
        typeof call.input.contract === 'object' && call.input.contract !== null
          ? (call.input.contract as Record<string, unknown>)
          : {}
      const contract = parseFigureContract({
        ...contractInput,
        centralClaim: String(contractInput.centralClaim ?? '') || thesis,
        figureFamily: String(contractInput.figureFamily ?? call.input.figureFamily ?? ''),
        domain: String(contractInput.domain ?? call.input.domain ?? ''),
        venue: String(contractInput.venue ?? call.input.venue ?? ''),
        output: {
          ...((contractInput.output ?? {}) as Record<string, unknown>),
          context: String(
            (contractInput.output as Record<string, unknown> | undefined)?.context ??
              call.input.outputContext ??
              '',
          ),
        },
      })
      const orchestration = await orchestrateFigure(
        {
          thesis,
          canvasW: slide.widthPx,
          canvasH: slide.heightPx,
          capability: call.input.capability as CapabilityInput | undefined,
          ...(contract ? { contract } : {}),
        },
        llm,
      )
      if (
        !orchestration.ok ||
        !orchestration.plan ||
        !orchestration.best ||
        !orchestration.routes ||
        !orchestration.critic ||
        orchestration.critic.verdict === 'RECOMPOSE'
      ) {
        const reason =
          orchestration.error ??
          'composition ' +
            (orchestration.critic?.verdict ?? 'failed') +
            ': ' +
            (orchestration.critic?.gateIssues.join('; ') || 'critic below threshold')
        return fail(t('aiFailNewElement'), reason)
      }
      const plan = orchestration.plan
      const solve = orchestration.best.solve
      // VisualPlan is strictly model-authored; no keyword fallback is invented
      // after the composer chose not to decompose a module.
      const visualPlan = orchestration.visualPlan ?? { modules: [] }
      const theme =
        getThemeById(String(call.input.themeId ?? 'academic-blue')) ??
        getThemeById('academic-blue')!
      const KIND_BY_TYPE: Record<string, string> = {
        'data-source': 'data-source',
        variable: 'input-node',
        mechanism: 'mechanism-module',
        process: 'process-node',
        model: 'model-module',
        method: 'process-node',
        actor: 'process-node',
        evidence: 'evidence-node',
        outcome: 'output-node',
        hypothesis: 'evidence-node',
        annotation: 'annotation',
        context: 'process-node',
      }
      const nodeById = new Map(plan.nodes.map((node) => [node.id, node]))
      const rectById = new Map<string, RouteRect>(
        solve.placements.map((placement) => [placement.id, placement]),
      )
      const actionId = beginAction('Create research figure (orchestrated)')
      const createdIds: string[] = []
      try {
        let latestSlide = slide
        const elementIdByNodeId = new Map<string, string>()
        for (const placement of solve.placements) {
          throwIfAborted(signal)
          const node = nodeById.get(placement.id)
          if (!node) throw new Error('unmeasured node "' + placement.id + '"')
          const domainProfile = orchestration.domain
            ? DOMAIN_PROFILES[orchestration.domain]
            : undefined
          const kind =
            domainProfile?.kindOverrides?.[node.type] ?? KIND_BY_TYPE[node.type] ?? 'process-node'
          const colors = resolveComponentColors(kind, theme.roles)
          const tokens = componentThemeTokens(kind)
          // Parent box shows ONLY the title. detail keywords have already been
          // promoted to independent visual units below; the page must not
          // regress into "big card with text" mode.
          // P0.5 typography SSOT: draw exactly the sizes the orchestrator
          // resolved (contract-scaled) — never raw style tables here.
          const nodeTypography = orchestration.typography?.node[node.id]
          const paragraphs: EditParagraph[] = [
            {
              runs: [
                {
                  text: node.visible.title,
                  bold: true,
                  fontSize: nodeTypography?.titlePt ?? SEMANTIC_NODE_STYLES[node.type].titleSizePt,
                  color: colors.text,
                },
              ],
            },
          ]
          const parentModule = visualPlan.modules.find((m) => m.moduleId === placement.id)
          const parentHeight = parentModule
            ? Math.max(
                placement.h,
                Math.min(slide.heightPx - 40, 34 + parentModule.units.length * 36),
              )
            : placement.h
          const r = await window.slidesApi.addElement({
            slideIndex: idx,
            kind: getComponentSpec(kind).preset,
            xPx: placement.x,
            yPx: placement.y,
            wPx: placement.w,
            hPx: parentHeight,
            fitWidthPx: access.fitWidthPx,
            paragraphs,
            fillColor: colors.fill,
            stroke: { color: colors.stroke, widthPt: 1.25 },
            semanticMetadata: {
              role: kind,
              themeFill: tokens.fill,
              themeStroke: tokens.stroke,
              themeText: tokens.text,
              componentType: 'research-module',
            },
          })
          if (!r) throw new Error('Failed to place node "' + placement.id + '"')
          createdIds.push(r.sourceId)
          elementIdByNodeId.set(placement.id, r.sourceId)
          throwIfAborted(signal)
          latestSlide = r.slide
          access.applySlide(idx, r.slide)

          // Micro layout: turn this module's visualUnits into independent PPT
          // shapes inside the parent box.
          const module = parentModule
          if (module) {
            const microMap = new Map([
              [placement.id, { x: placement.x, y: placement.y, w: placement.w, h: parentHeight }],
            ])
            const micro = layoutMicro([module], microMap)
            for (const u of micro.units) {
              throwIfAborted(signal)
              const role = u.role
              const shapeKind = (() => {
                const u2 = module.units.find((x) => x.id === u.id)
                return u2?.shape ?? ROLE_SHAPE[role]
              })()
              const unitColor = resolveComponentColors(
                KIND_BY_TYPE[node.type] ?? 'process-node',
                theme.roles,
              )
              const unitParagraphs: EditParagraph[] = [
                {
                  runs: [
                    {
                      text: u.label,
                      bold: role === 'output' || role === 'substep',
                      fontSize:
                        role === 'annotation'
                          ? (orchestration.typography?.micro.annotationPt ?? 9.5)
                          : role === 'substep' || role === 'output'
                            ? (orchestration.typography?.micro.primaryPt ?? 10.5)
                            : (orchestration.typography?.micro.secondaryPt ?? 9.5),
                      color: unitColor.text,
                    },
                  ],
                  align: 'center',
                },
              ]
              if (u.detail) {
                unitParagraphs.push({
                  runs: [
                    {
                      text: u.detail,
                      fontSize: orchestration.typography?.micro.secondaryPt ?? 9,
                      color: unitColor.subtitle,
                    },
                  ],
                  align: 'center',
                })
              }
              const ur = await window.slidesApi.addElement({
                slideIndex: idx,
                kind: shapePreset(shapeKind),
                xPx: u.x,
                yPx: u.y,
                wPx: u.w,
                hPx: Math.max(u.h, 42),
                fitWidthPx: access.fitWidthPx,
                paragraphs: unitParagraphs,
                fillColor: unitColor.fill,
                stroke: { color: unitColor.stroke, widthPt: 0.75 },
                semanticMetadata: {
                  role: 'visual-unit',
                  themeFill: unitColor.fill,
                  themeStroke: unitColor.stroke,
                  themeText: unitColor.text,
                  componentType: 'research-micro',
                  ...(u.semanticNodeId ? { semanticNodeId: u.semanticNodeId } : {}),
                  ...(u.semanticEdgeId ? { semanticEdgeId: u.semanticEdgeId } : {}),
                },
              })
              if (ur) createdIds.push(ur.sourceId)
              throwIfAborted(signal)
              if (ur) {
                latestSlide = ur.slide
                access.applySlide(idx, ur.slide)
              }
            }
          }
        }
        let boundCount = 0
        for (const route of orchestration.routes) {
          throwIfAborted(signal)
          if (route.status !== 'routed' || !route.start || !route.end || !route.kind) continue
          const fromId = elementIdByNodeId.get(route.fromId)
          const toId = elementIdByNodeId.get(route.toId)
          const fromRect = rectById.get(route.fromId)
          const toRect = rectById.get(route.toId)
          if (!fromId || !toId || !fromRect || !toRect) continue
          const p1 = anchorPoint(fromRect, route.start.side)
          const p2 = anchorPoint(toRect, route.end.side)
          const cr = await window.slidesApi.addElement({
            slideIndex: idx,
            kind: route.kind === 'elbow' ? 'bentConnector3' : 'line',
            xPx: Math.min(p1.x, p2.x),
            yPx: Math.min(p1.y, p2.y),
            wPx: Math.max(Math.abs(p2.x - p1.x), 1),
            hPx: Math.max(Math.abs(p2.y - p1.y), 1),
            fitWidthPx: access.fitWidthPx,
            stroke: {
              color: connectorColor(theme.roles),
              widthPt: route.presentation === 'inhibition' ? 2 : 1.5,
              ...(route.presentation === 'dashed-arrow' || route.presentation === 'inhibition'
                ? { dash: route.presentation === 'inhibition' ? 'dash' : 'sysDash' }
                : {}),
            },
            semanticMetadata: {
              role: route.role + '-connector',
              themeFill: 'none',
              themeStroke: 'connector',
              themeText: 'none',
              componentType: 'research-connector',
              ...(route.semanticEdgeId ? { semanticEdgeId: route.semanticEdgeId } : {}),
              ...(route.presentation ? { relationPresentation: route.presentation } : {}),
            },
          })
          if (!cr) throw new Error('Failed to place ' + route.role + ' connector ' + route.key)
          createdIds.push(cr.sourceId)
          latestSlide = cr.slide
          access.applySlide(idx, cr.slide)
          // §24 inhibition semantics: a flat-ended inhibition is realised as a
          // native short perpendicular bar at the TARGET end, bound to the
          // connector via semanticEdgeId (editable, never rasterized).
          if (route.presentation === 'inhibition') {
            const horizontal = route.start.side === 'right' || route.start.side === 'left'
            const barLen = 12
            const bar = await window.slidesApi.addElement({
              slideIndex: idx,
              kind: 'line',
              xPx: horizontal ? p2.x - barLen / 2 : p2.x,
              yPx: horizontal ? p2.y : p2.y - barLen / 2,
              wPx: horizontal ? barLen : 1,
              hPx: horizontal ? 1 : barLen,
              fitWidthPx: access.fitWidthPx,
              stroke: { color: connectorColor(theme.roles), widthPt: 2 },
              semanticMetadata: {
                role: 'inhibition-bar',
                themeFill: 'none',
                themeStroke: 'connector',
                themeText: 'none',
                componentType: 'research-inhibition-bar',
                semanticEdgeId: route.semanticEdgeId,
              },
            })
            if (bar) {
              createdIds.push(bar.sourceId)
              latestSlide = bar.slide
              access.applySlide(idx, bar.slide)
            }
          }
          const boundSlide = await window.slidesApi.editConnectorEndpoints({
            slideIndex: idx,
            sourceId: cr.sourceId,
            x1Px: p1.x,
            y1Px: p1.y,
            x2Px: p2.x,
            y2Px: p2.y,
            fitWidthPx: access.fitWidthPx,
            ...(route.role === 'feedback'
              ? { routeYPx: route.routeY ?? slide.heightPx - Math.round(slide.heightPx * 0.04) }
              : route.routeY !== undefined
                ? { routeYPx: route.routeY }
                : {}),
            start: { targetId: fromId, idx: route.start.idx },
            end: { targetId: toId, idx: route.end.idx },
          })
          if (!boundSlide) throw new Error('Failed to bind connector ' + route.key)
          latestSlide = boundSlide
          access.applySlide(idx, boundSlide)
          boundCount++
        }
        const renderIssues = auditSlideLayout(latestSlide)
        if (renderIssues.length > 0) {
          throw new Error('Post-write layout audit failed: ' + renderIssues.join('; '))
        }
        completeAction(
          actionId,
          'orchestrated figure: ' +
            solve.placements.length +
            ' nodes, ' +
            boundCount +
            '/' +
            orchestration.routes.length +
            ' connectors bound',
        )
        return {
          output:
            'Created an orchestrated research figure on page ' +
            (idx + 1) +
            ': ' +
            solve.placements.length +
            ' nodes, ' +
            boundCount +
            ' native-bound connectors. Composition: ' +
            orchestration.best.source +
            (orchestration.best.priorId ? '/' + orchestration.best.priorId : '') +
            ' at autonomy ' +
            orchestration.autonomy +
            '. Critic: ' +
            orchestration.critic.verdict +
            ' (overall ' +
            orchestration.critic.scores.overall +
            '/10, crossings ' +
            orchestration.best.crossings +
            ', intent drift ' +
            Math.round(orchestration.best.solve.intentDriftPx) +
            'px). Element ids: ' +
            [...elementIdByNodeId.values()].join(', ') +
            '.',
          mutated: true,
          summary: t('aiSumNewShape', { n: idx + 1 }),
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        const rollbackErrors = await revertCreatedElements(access, idx, createdIds)
        revertAction(actionId)
        return fail(
          t('aiFailNewElement'),
          rollbackErrors.length > 0
            ? reason + ' (rollback incomplete for ' + rollbackErrors.length + ' elements)'
            : reason,
        )
      }
    }
    case 'create_input_core_output': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailNewElement'), `slideIndex out of range (0-${slides.length - 1})`)
      type PlanNodeIn = { component?: unknown; title?: unknown; subtitle?: unknown }
      const readNodes = (v: unknown) =>
        Array.isArray(v)
          ? (v as PlanNodeIn[])
              .map((n) => ({
                component: String(n.component ?? 'process-node'),
                title: String(n.title ?? ''),
                ...(n.subtitle != null ? { subtitle: String(n.subtitle) } : {}),
              }))
              .filter((n) => n.title)
          : []
      const inputNodes = readNodes(call.input.inputNodes)
      const coreNodes = readNodes(call.input.coreNodes)
      const outputNodes = readNodes(call.input.outputNodes)
      if (inputNodes.length + coreNodes.length + outputNodes.length === 0)
        return fail(t('aiFailNewElement'), 'At least one node is required')
      const planError = researchRecipePlanError(
        mode,
        state,
        'input-core-output',
        { input: inputNodes, core: coreNodes, output: outputNodes },
        call.input.feedback === true,
      )
      if (planError) return fail(t('aiFailNewElement'), planError)
      const recipeNodes = [...inputNodes, ...coreNodes, ...outputNodes]
      const provenanceError = researchRecipeDataSourceError(call, state, recipeNodes)
      if (provenanceError) return fail(t('aiFailNewElement'), provenanceError)
      const sampleNote =
        countSpecificFigures(researchRecipeText(recipeNodes)) > 0 &&
        call.input.dataSource === 'sample'
          ? SAMPLE_DATA_NOTE
          : ''

      const theme =
        getThemeById(String(call.input.themeId ?? 'academic-blue')) ??
        getThemeById('academic-blue')!
      let layout: ReturnType<typeof layoutInputCoreOutput>
      try {
        // Connector topology comes exclusively from the validated FigurePlan's
        // explicit edges; without a plan there are no connectors to draw.
        const plan =
          mode === 'research' && state?.lastFigurePlan?.figureType === 'input-core-output'
            ? state.lastFigurePlan
            : null
        layout = layoutInputCoreOutput({
          inputNodes,
          coreNodes,
          outputNodes,
          edges: (plan?.edges ?? []).flatMap((edge) =>
            edge.role === 'main' || edge.role === 'feedback'
              ? [
                  {
                    from: edge.from,
                    to: edge.to,
                    role: edge.role,
                    relation: edge.relation,
                    ...(edge.label ? { label: edge.label } : {}),
                  },
                ]
              : [],
          ),
          canvasW: slide.widthPx,
          canvasH: slide.heightPx,
        })
      } catch (err) {
        return fail(t('aiFailNewElement'), err instanceof Error ? err.message : String(err))
      }
      const geometryAudit = auditInputCoreOutput(layout, slide.widthPx, slide.heightPx, {
        requireFeedback: call.input.feedback === true,
      })
      if (!geometryAudit.ok) {
        return fail(
          t('aiFailNewElement'),
          `Input–Core–Output audit failed:\n${geometryAudit.issues.map((issue) => `- ${issue}`).join('\n')}`,
        )
      }
      const actionId = beginAction('Create Input–Core–Output figure')
      const createdIds: string[] = []
      try {
        let latestSlide = slide
        const nodeIds: string[] = []
        for (const el of layout.elements) {
          throwIfAborted(signal)
          const colors = resolveComponentColors(el.component, theme.roles)
          const tokens = componentThemeTokens(el.component)
          const paragraphs: EditParagraph[] = [
            {
              runs: [{ text: el.title, bold: true, fontSize: el.titleFontPt, color: colors.text }],
            },
            ...(el.subtitle
              ? [{ runs: [{ text: el.subtitle, fontSize: el.bodyFontPt, color: colors.subtitle }] }]
              : []),
          ]
          const r = await window.slidesApi.addElement({
            slideIndex: idx,
            kind: el.preset,
            xPx: el.x,
            yPx: el.y,
            wPx: el.w,
            hPx: el.h,
            fitWidthPx: access.fitWidthPx,
            paragraphs,
            fillColor: colors.fill,
            stroke: { color: colors.stroke, widthPt: 1.25 },
            semanticMetadata: {
              role: el.component,
              themeFill: tokens.fill,
              themeStroke: tokens.stroke,
              themeText: tokens.text,
              componentType: 'research-module',
            },
          })
          if (!r) throw new Error(`Failed to place node "${el.title}"`)
          createdIds.push(r.sourceId)
          throwIfAborted(signal)
          latestSlide = r.slide
          access.applySlide(idx, r.slide)
          nodeIds.push(r.sourceId)
          latestSlide = await fitResearchNodeText(access, idx, r.sourceId, el.title, signal)
          commitAction(actionId, `node ${el.title}`)
        }
        // Main-flow chain + optional feedback loop, endpoints bound so moves follow.
        const seq = layout.elements
        let boundCount = 0
        const routes = [
          ...layout.connectors.filter((c) => c.role === 'main'),
          ...layout.connectors.filter((c) => c.role === 'feedback'),
        ]
        for (const c of routes) {
          throwIfAborted(signal)
          const fromId = nodeIds[c.fromIndex]
          const toId = nodeIds[c.toIndex]
          if (!fromId || !toId || fromId === toId) continue
          const a = seq[c.fromIndex]
          const b = seq[c.toIndex]
          const start =
            c.role === 'feedback'
              ? { x: a.x + a.w / 2, y: a.y + a.h, idx: 2 }
              : { x: a.x + a.w, y: a.y + a.h / 2, idx: 3 }
          const end =
            c.role === 'feedback'
              ? { x: b.x + b.w / 2, y: b.y + b.h, idx: 2 }
              : { x: b.x, y: b.y + b.h / 2, idx: 1 }
          const x1 = start.x
          const y1 = start.y
          const x2 = end.x
          const y2 = end.y
          const preset =
            c.role === 'feedback'
              ? 'bentConnector3'
              : c.kind === 'curved'
                ? 'curvedConnector3'
                : 'line'
          const cr = await window.slidesApi.addElement({
            slideIndex: idx,
            kind: preset,
            xPx: Math.min(x1, x2),
            yPx: Math.min(y1, y2),
            wPx: Math.max(Math.abs(x2 - x1), 1),
            hPx: Math.max(Math.abs(y2 - y1), 1),
            fitWidthPx: access.fitWidthPx,
            stroke: { color: connectorColor(theme.roles), widthPt: 1.5 },
            semanticMetadata: {
              role: `${c.role}-connector`,
              themeFill: 'none',
              themeStroke: 'connector',
              themeText: 'none',
              componentType: 'research-connector',
            },
          })
          if (!cr) throw new Error(`Failed to place ${c.role} connector`)
          createdIds.push(cr.sourceId)
          throwIfAborted(signal)
          latestSlide = cr.slide
          access.applySlide(idx, cr.slide)
          const boundSlide = await window.slidesApi.editConnectorEndpoints({
            slideIndex: idx,
            sourceId: cr.sourceId,
            x1Px: x1,
            y1Px: y1,
            x2Px: x2,
            y2Px: y2,
            fitWidthPx: access.fitWidthPx,
            ...(c.laneY != null ? { routeYPx: c.laneY } : {}),
            start: { targetId: fromId, idx: start.idx },
            end: { targetId: toId, idx: end.idx },
          })
          if (!boundSlide) throw new Error(`Failed to bind ${c.role} connector`)
          throwIfAborted(signal)
          latestSlide = boundSlide
          access.applySlide(idx, boundSlide)
          boundCount++
        }
        const renderIssues = auditSlideLayout(latestSlide)
        if (renderIssues.length > 0) {
          throw new Error(`Post-write layout audit failed: ${renderIssues.join('; ')}`)
        }
        completeAction(
          actionId,
          `${seq.length} nodes, ${routes.length} connectors (${boundCount} bound)`,
        )
        return {
          output: `Created an Input–Core–Output framework on page ${idx + 1}: ${seq.length} nodes across three zones, ${routes.length} connectors (${boundCount} endpoint-bound). Element ids: ${nodeIds.filter(Boolean).join(', ')}.${sampleNote}${formatAudit(renderIssues)}`,
          mutated: true,
          summary: t('aiSumNewShape', { n: idx + 1 }),
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        const rollbackErrors = await revertCreatedElements(access, idx, createdIds)
        const rollbackNote = rollbackErrors.length
          ? ` Rollback failed for: ${rollbackErrors.join(', ')}.`
          : ' Created elements were reverted.'
        revertAction(actionId, reason + rollbackNote)
        return fail(
          t('aiFailNewElement'),
          `Research figure creation failed: ${reason}.${rollbackNote}`,
        )
      }
    }

    case 'create_horizontal_pipeline': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailNewElement'), `slideIndex out of range (0-${slides.length - 1})`)
      const rawNodes = Array.isArray(call.input.nodes) ? call.input.nodes : []
      const nodes = rawNodes
        .map((node) => {
          const n = node as { component?: unknown; title?: unknown; subtitle?: unknown }
          return {
            component: String(n.component ?? 'process-node'),
            title: String(n.title ?? ''),
            ...(n.subtitle != null ? { subtitle: String(n.subtitle) } : {}),
          }
        })
        .filter((node) => node.title)
      if (!nodes.length) return fail(t('aiFailNewElement'), 'At least one node is required')
      const planError = researchRecipePlanError(mode, state, 'horizontal-pipeline', {
        pipeline: nodes,
      })
      if (planError) return fail(t('aiFailNewElement'), planError)
      const provenanceError = researchRecipeDataSourceError(call, state, nodes)
      if (provenanceError) return fail(t('aiFailNewElement'), provenanceError)
      const sampleNote =
        countSpecificFigures(researchRecipeText(nodes)) > 0 && call.input.dataSource === 'sample'
          ? SAMPLE_DATA_NOTE
          : ''

      let layout: ReturnType<typeof layoutHorizontalPipeline>
      try {
        // Connector topology comes exclusively from the validated FigurePlan's
        // explicit edges; without a plan there are no connectors to draw.
        const plan =
          mode === 'research' && state?.lastFigurePlan?.figureType === 'horizontal-pipeline'
            ? state.lastFigurePlan
            : null
        layout = layoutHorizontalPipeline({
          nodes,
          edges: (plan?.edges ?? []).flatMap((edge) =>
            edge.role === 'main' || edge.role === 'feedback'
              ? [
                  {
                    from: edge.from,
                    to: edge.to,
                    role: edge.role,
                    relation: edge.relation,
                    ...(edge.label ? { label: edge.label } : {}),
                  },
                ]
              : [],
          ),
          canvasW: slide.widthPx,
          canvasH: slide.heightPx,
        })
      } catch (err) {
        return fail(t('aiFailNewElement'), err instanceof Error ? err.message : String(err))
      }
      const audit = auditHorizontalPipeline(layout, slide.widthPx, slide.heightPx)
      if (!audit.ok) {
        return fail(
          t('aiFailNewElement'),
          `Horizontal Pipeline audit failed:\n${audit.issues.map((issue) => `- ${issue}`).join('\n')}`,
        )
      }

      const theme =
        getThemeById(String(call.input.themeId ?? 'academic-blue')) ??
        getThemeById('academic-blue')!
      const actionId = beginAction('Create Horizontal Pipeline')
      const createdIds: string[] = []
      try {
        let latestSlide = slide
        const nodeIds: string[] = []
        for (const el of layout.elements) {
          throwIfAborted(signal)
          const colors = resolveComponentColors(el.component, theme.roles)
          const tokens = componentThemeTokens(el.component)
          const paragraphs: EditParagraph[] = [
            {
              runs: [{ text: el.title, bold: true, fontSize: el.titleFontPt, color: colors.text }],
            },
            ...(el.subtitle
              ? [{ runs: [{ text: el.subtitle, fontSize: el.bodyFontPt, color: colors.subtitle }] }]
              : []),
          ]
          const r = await window.slidesApi.addElement({
            slideIndex: idx,
            kind: el.preset,
            xPx: el.x,
            yPx: el.y,
            wPx: el.w,
            hPx: el.h,
            fitWidthPx: access.fitWidthPx,
            paragraphs,
            fillColor: colors.fill,
            stroke: { color: colors.stroke, widthPt: 1.25 },
            semanticMetadata: {
              role: el.component,
              themeFill: tokens.fill,
              themeStroke: tokens.stroke,
              themeText: tokens.text,
              componentType: 'research-module',
            },
          })
          if (!r) throw new Error(`Failed to place node "${el.title}"`)
          createdIds.push(r.sourceId)
          throwIfAborted(signal)
          latestSlide = r.slide
          access.applySlide(idx, r.slide)
          nodeIds.push(r.sourceId)
          latestSlide = await fitResearchNodeText(access, idx, r.sourceId, el.title, signal)
          commitAction(actionId, `node ${el.title}`)
        }

        for (const c of layout.connectors) {
          throwIfAborted(signal)
          const fromId = nodeIds[c.fromIndex]
          const toId = nodeIds[c.toIndex]
          if (!fromId || !toId)
            throw new Error(`Missing connector endpoint for ${c.fromIndex} -> ${c.toIndex}`)
          const a = layout.elements[c.fromIndex]!
          const b = layout.elements[c.toIndex]!
          const x1 = a.x + a.w
          const y1 = a.y + a.h / 2
          const x2 = b.x
          const y2 = b.y + b.h / 2
          const cr = await window.slidesApi.addElement({
            slideIndex: idx,
            kind: c.kind === 'curved' ? 'curvedConnector3' : 'line',
            xPx: Math.min(x1, x2),
            yPx: Math.min(y1, y2),
            wPx: Math.max(Math.abs(x2 - x1), 1),
            hPx: Math.max(Math.abs(y2 - y1), 1),
            fitWidthPx: access.fitWidthPx,
            stroke: { color: connectorColor(theme.roles), widthPt: 1.5 },
            semanticMetadata: {
              role: `${c.role}-connector`,
              themeFill: 'none',
              themeStroke: 'connector',
              themeText: 'none',
              componentType: 'research-connector',
            },
          })
          if (!cr) throw new Error(`Failed to place ${c.role} connector`)
          createdIds.push(cr.sourceId)
          throwIfAborted(signal)
          latestSlide = cr.slide
          access.applySlide(idx, cr.slide)
          const boundSlide = await window.slidesApi.editConnectorEndpoints({
            slideIndex: idx,
            sourceId: cr.sourceId,
            x1Px: x1,
            y1Px: y1,
            x2Px: x2,
            y2Px: y2,
            fitWidthPx: access.fitWidthPx,
            ...(c.laneY != null ? { routeYPx: c.laneY } : {}),
            start: { targetId: fromId, idx: 3 },
            end: { targetId: toId, idx: 1 },
          })
          if (!boundSlide) throw new Error(`Failed to bind ${c.role} connector`)
          throwIfAborted(signal)
          latestSlide = boundSlide
          access.applySlide(idx, boundSlide)
          commitAction(actionId, `connector ${c.fromIndex + 1}->${c.toIndex + 1}`)
        }
        const renderIssues = auditSlideLayout(latestSlide)
        if (renderIssues.length > 0) {
          throw new Error(`Post-write layout audit failed: ${renderIssues.join('; ')}`)
        }
        completeAction(
          actionId,
          `${layout.elements.length} nodes, ${layout.connectors.length} connectors`,
        )
        return {
          output: `Created a horizontal research pipeline on page ${idx + 1}: ${layout.elements.length} nodes and ${layout.connectors.length} bound connectors. Element ids: ${nodeIds.join(', ')}.${sampleNote}${formatAudit(renderIssues)}`,
          mutated: true,
          summary: t('aiSumNewShape', { n: idx + 1 }),
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        const rollbackErrors = await revertCreatedElements(access, idx, createdIds)
        const rollbackNote = rollbackErrors.length
          ? ` Rollback failed for: ${rollbackErrors.join(', ')}.`
          : ' Created elements were reverted.'
        revertAction(actionId, reason + rollbackNote)
        return fail(
          t('aiFailNewElement'),
          `Research figure creation failed: ${reason}.${rollbackNote}`,
        )
      }
    }

    case 'add_chart': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide) return fail(t('aiFailChart'), `slideIndex out of range (0-${slides.length - 1})`)
      const categories = Array.isArray(call.input.categories)
        ? call.input.categories.map(String)
        : []
      const seriesRaw = Array.isArray(call.input.series) ? call.input.series : []
      const series = seriesRaw
        .map((s) => ({
          name: String((s as { name?: unknown }).name ?? ''),
          values: Array.isArray((s as { values?: unknown }).values)
            ? ((s as { values: unknown[] }).values.map(Number) as number[])
            : [],
        }))
        .filter((s) => s.values.length > 0)
      if (categories.length === 0 || series.length === 0) {
        return fail(t('aiFailChart'), 'Neither categories nor series may be empty')
      }
      const gateErr = dataSourceGateError(call, state)
      if (gateErr) return fail(t('aiFailChart'), gateErr)
      const defW = Math.round(slide.widthPx * 0.62)
      const defH = Math.round(slide.heightPx * 0.62)
      const w = Number(call.input.w) || defW
      const h = Number(call.input.h) || defH
      const r = await window.slidesApi.addChart({
        slideIndex: idx,
        kind: String(call.input.kind) as
          'bar' | 'barStacked' | 'line' | 'area' | 'pie' | 'doughnut',
        ...(call.input.title ? { title: String(call.input.title) } : {}),
        categories,
        series,
        xPx:
          Number.isFinite(Number(call.input.x)) && call.input.x != null
            ? Number(call.input.x)
            : Math.round((slide.widthPx - w) / 2),
        yPx:
          Number.isFinite(Number(call.input.y)) && call.input.y != null
            ? Number(call.input.y)
            : Math.round((slide.heightPx - h) / 2),
        wPx: w,
        hPx: h,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r) return fail(t('aiFailChart'), 'Insertion failed (check kind and data)')
      access.applySlide(idx, r.slide)
      const sampleNote = call.input.dataSource === 'sample' ? SAMPLE_DATA_NOTE : ''
      return {
        output: `Inserted a ${String(call.input.kind)} chart on page ${idx + 1}, element id=${r.sourceId}.${sampleNote}`,
        mutated: true,
        summary: t('aiSumChart', { n: idx + 1 }),
      }
    }

    case 'add_smartart': {
      const scratchBlockSA = blockScratchBuild(call.name, slides, state)
      if (scratchBlockSA) return scratchBlockSA
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailSmartart'), `slideIndex out of range (0-${slides.length - 1})`)
      const items = Array.isArray(call.input.items)
        ? call.input.items.map(String).filter(Boolean)
        : []
      if (items.length < 2) return fail(t('aiFailSmartart'), 'items requires at least 2 entries')
      const defW = Math.round(slide.widthPx * 0.7)
      const defH = Math.round(slide.heightPx * 0.5)
      const w = Number(call.input.w) || defW
      const h = Number(call.input.h) || defH
      const r = await window.slidesApi.addSmartArt({
        slideIndex: idx,
        layout: String(call.input.layout) as AddSmartArtOp['layout'],
        items,
        xPx:
          Number.isFinite(Number(call.input.x)) && call.input.x != null
            ? Number(call.input.x)
            : Math.round((slide.widthPx - w) / 2),
        yPx:
          Number.isFinite(Number(call.input.y)) && call.input.y != null
            ? Number(call.input.y)
            : Math.round((slide.heightPx - h) / 2),
        wPx: w,
        hPx: h,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r) return fail(t('aiFailSmartart'), 'Insertion failed (check layout)')
      access.applySlide(idx, r.slide)
      return {
        output: `Inserted a ${String(call.input.layout)} diagram (${items.length} nodes) on page ${idx + 1}, element id=${r.sourceId}.`,
        mutated: true,
        summary: t('aiSumSmartart', { n: idx + 1 }),
      }
    }

    case 'add_table': {
      const idx = Number(call.input.slideIndex)
      const slide = slides[idx]
      if (!slide) return fail(t('aiFailTable'), `slideIndex out of range (0-${slides.length - 1})`)
      const rows = Number(call.input.rows)
      const cols = Number(call.input.cols)
      if (
        !Number.isInteger(rows) ||
        !Number.isInteger(cols) ||
        rows < 1 ||
        cols < 1 ||
        rows > 30 ||
        cols > 12
      ) {
        return fail(t('aiFailTable'), 'Invalid rows (1-30) / cols (1-12)')
      }
      const defW = Math.round(slide.widthPx * 0.7)
      const defH = Math.round(Math.min(slide.heightPx * 0.6, rows * 40 + 20))
      const w = Number(call.input.w) || defW
      const h = Number(call.input.h) || defH
      const r = await window.slidesApi.addTable({
        slideIndex: idx,
        rows,
        cols,
        xPx:
          Number.isFinite(Number(call.input.x)) && call.input.x != null
            ? Number(call.input.x)
            : Math.round((slide.widthPx - w) / 2),
        yPx:
          Number.isFinite(Number(call.input.y)) && call.input.y != null
            ? Number(call.input.y)
            : Math.round((slide.heightPx - h) / 2),
        wPx: w,
        hPx: h,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r) return fail(t('aiFailTable'), 'Insertion failed')
      let updated = r.slide
      // Fill cells one by one (cells optional; out-of-range parts ignored)
      const cells = Array.isArray(call.input.cells) ? (call.input.cells as unknown[][]) : []
      let filled = 0
      for (let ri = 0; ri < Math.min(cells.length, rows); ri++) {
        const rowCells = Array.isArray(cells[ri]) ? cells[ri]! : []
        for (let ci = 0; ci < Math.min(rowCells.length, cols); ci++) {
          const text = String(rowCells[ci] ?? '')
          if (!text) continue
          const u = await window.slidesApi.editTableCell({
            slideIndex: idx,
            sourceId: r.sourceId,
            row: ri,
            col: ci,
            paragraphs: [{ runs: [{ text }] }],
          })
          if (u) {
            updated = u
            filled++
          }
        }
      }
      access.applySlide(idx, updated)
      return {
        output: `Inserted a ${rows}×${cols} table on page ${idx + 1}, element id=${r.sourceId}${filled ? `, filled ${filled} cell(s) with text` : ''}.`,
        mutated: true,
        summary: t('aiSumTable', { n: idx + 1 }),
      }
    }

    case 'edit_table_cell': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailEditTable'), `slideIndex out of range (0-${slides.length - 1})`)
      const paragraphs = toEditParagraphs(call.input.paragraphs)
      if (!paragraphs) return fail(t('aiFailEditTable'), 'paragraphs must be a non-empty array')
      const row = Number(call.input.row)
      const col = Number(call.input.col)
      const updated = await window.slidesApi.editTableCell({
        slideIndex: idx,
        sourceId,
        row,
        col,
        paragraphs,
      })
      if (!updated)
        return fail(
          t('aiFailEditTable'),
          `Table ${sourceId} not found or cell (${row},${col}) out of range`,
        )
      access.applySlide(idx, updated)
      return {
        output: `Replaced the text of cell (${row},${col}) in table ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumTableCell', { n: idx + 1 }),
      }
    }

    case 'edit_table_structure': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailTableStructure'), `slideIndex out of range (0-${slides.length - 1})`)
      const kind = String(call.input.kind) as
        'insert-row' | 'delete-row' | 'insert-col' | 'delete-col'
      if (!['insert-row', 'delete-row', 'insert-col', 'delete-col'].includes(kind)) {
        return fail(t('aiFailTableStructure'), 'Invalid kind')
      }
      const r = await window.slidesApi.tableStructure({
        slideIndex: idx,
        sourceId,
        kind,
        index: Number(call.input.index),
        ...(call.input.before ? { before: true } : {}),
      })
      if (!r)
        return fail(
          t('aiFailTableStructure'),
          `Operation failed (table ${sourceId} does not exist, index out of range, or the last row/column cannot be deleted)`,
        )
      access.applySlide(idx, r.slide)
      return {
        output: `Applied ${kind} (index=${Number(call.input.index)}) to table ${sourceId} on page ${idx + 1}. The table id may have been updated to ${r.sourceId}.`,
        mutated: true,
        summary: t('aiSumTableStructure', {
          n: idx + 1,
          op: t(
            kind.startsWith('insert')
              ? kind.endsWith('row')
                ? 'aiOpInsertRow'
                : 'aiOpInsertCol'
              : kind.endsWith('row')
                ? 'aiOpDeleteRow'
                : 'aiOpDeleteCol',
          ),
        }),
      }
    }

    case 'edit_table_style': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailTableStyle'), `slideIndex out of range (0-${slides.length - 1})`)
      const op: import('../../shared/ipc').EditTableStyleOp = { slideIndex: idx, sourceId }
      if (call.input.styleName != null) op.styleName = String(call.input.styleName)
      if (call.input.firstRow != null) op.firstRow = Boolean(call.input.firstRow)
      if (call.input.bandRow != null) op.bandRow = Boolean(call.input.bandRow)
      if (call.input.shadingColor != null) op.shadingColor = String(call.input.shadingColor)
      if (call.input.borderColor != null) op.borderColor = String(call.input.borderColor)
      if (call.input.borderWidthPt != null) op.borderWidthPt = Number(call.input.borderWidthPt)
      if (call.input.borderPreset != null)
        op.borderPreset = String(call.input.borderPreset) as 'all' | 'none'
      const updated = await window.slidesApi.editTableStyle(op)
      if (!updated)
        return fail(
          t('aiFailTableStyle'),
          `Operation failed (table ${sourceId} does not exist or is not of type table)`,
        )
      access.applySlide(idx, updated.slide)
      return {
        output: `Updated the style of table ${sourceId} on page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumTableStyle', { n: idx + 1 }),
      }
    }

    case 'edit_chart': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailChartEdit'), `slideIndex out of range (0-${slides.length - 1})`)
      const op: import('../../shared/ipc').EditChartOp = { slideIndex: idx, sourceId }
      if (call.input.kind != null)
        op.kind = String(call.input.kind) as import('../../shared/ipc').EditChartOp['kind']
      if (Array.isArray(call.input.categories))
        op.categories = (call.input.categories as unknown[]).map(String)
      if (Array.isArray(call.input.series)) {
        const gateErr = dataSourceGateError(call, state)
        if (gateErr) return fail(t('aiFailChartEdit'), gateErr)
        op.series = (call.input.series as Array<{ name: unknown; values: unknown[] }>).map((s) => ({
          name: String(s.name ?? ''),
          values: (Array.isArray(s.values) ? s.values : []).map(Number),
        }))
      }
      if (call.input.colorScheme != null) op.colorScheme = String(call.input.colorScheme)
      if (call.input.title != null) op.title = String(call.input.title)
      if (call.input.legendPos != null)
        op.legendPos = String(
          call.input.legendPos,
        ) as import('../../shared/ipc').EditChartOp['legendPos']
      if (typeof call.input.dataLabels === 'boolean') op.dataLabels = call.input.dataLabels
      if (typeof call.input.gridlines === 'boolean') op.gridlines = call.input.gridlines
      if (call.input.switchRowCol === true) op.switchRowCol = true
      const updated = await window.slidesApi.editChart(op)
      if (!updated)
        return fail(
          t('aiFailChartEdit'),
          `Operation failed (element ${sourceId} does not exist or is not a chart)`,
        )
      access.applySlide(idx, updated.slide)
      const sampleNote = op.series && call.input.dataSource === 'sample' ? SAMPLE_DATA_NOTE : ''
      return {
        output: `Updated chart ${sourceId} on page ${idx + 1}.${sampleNote}`,
        mutated: true,
        summary: t('aiSumChartEdit', { n: idx + 1 }),
      }
    }

    case 'set_slide_background': {
      const idx = Number(call.input.slideIndex)
      const color = String(call.input.color ?? '')
      if (idx !== -1 && !slides[idx])
        return fail(t('aiFailBackground'), `slideIndex out of range (0-${slides.length - 1} or -1)`)
      if (!/^#?[0-9a-fA-F]{6}$/.test(color))
        return fail(t('aiFailBackground'), 'color must be #RRGGBB')
      const r = await window.slidesApi.editBackground({
        slideIndex: idx,
        kind: 'solid',
        color: color.startsWith('#') ? color : `#${color}`,
        fitWidthPx: access.fitWidthPx,
      })
      if (!r) return fail(t('aiFailBackground'), 'Setting failed')
      access.applyDeck(r)
      return {
        output:
          idx === -1
            ? `Set the background of all ${r.length} pages to ${color}.`
            : `Set the background of page ${idx + 1} to ${color}.`,
        mutated: true,
        summary: idx === -1 ? t('aiSumBackgroundAll') : t('aiSumBackground', { n: idx + 1 }),
      }
    }

    case 'apply_ops': {
      const opsIn = Array.isArray(call.input.ops) ? (call.input.ops as unknown[]) : null
      if (!opsIn || opsIn.length === 0)
        return fail(t('aiFailApplyOps'), 'ops must be a non-empty array')
      const r = await window.slidesApi.applyTxn?.({
        ops: opsIn,
        ...(call.input.dry_run === true ? { dryRun: true } : {}),
        ...(call.input.isolation === 'per_op' ? { isolation: 'per_op' as const } : {}),
      })
      if (!r) return fail(t('aiFailApplyOps'), 'The transaction could not be executed')
      const failLines = (r.failures ?? []).map((f) => `- ops[${f.index}]: ${f.error}`).join('\n')
      if (r.dryRun) {
        const planStr = (r.plan ?? []).join('\n')
        return {
          output:
            `Dry run — the deck was NOT modified.\n` +
            (planStr ? `Valid plan:\n${planStr}\n` : '') +
            (failLines ? `Rejected ops:\n${failLines}\n` : 'All ops validated.\n') +
            `Resend with dry_run omitted to apply.`,
          mutated: false,
          summary: t('aiSumApplyOpsDryRun'),
        }
      }
      if (!r.applied) {
        return fail(
          t('aiFailApplyOps'),
          `Nothing was applied${call.input.isolation === 'per_op' ? '' : ' (atomic)'}:\n${failLines || 'unknown failure'}`,
        )
      }
      // Ops can delete slides — clamp the current index into the rebuilt deck
      // (the dedicated delete_slide tool does the same)
      access.applyDeck(r.slides!, Math.max(0, Math.min(access.getCurrent(), r.slides!.length - 1)))
      const created = (r.records ?? []).flatMap((rec) => rec.created ?? [])
      const doneStr = (r.records ?? [])
        .map((rec) => `${rec.op}${rec.target ? ` @${rec.target}` : ''}`)
        .join(', ')
      return {
        output:
          `Applied ${r.records?.length ?? 0} op(s): ${doneStr}.` +
          (created.length ? ` New element ids: ${created.join(', ')}.` : '') +
          (failLines ? `\nSkipped (per_op):\n${failLines}` : ''),
        mutated: true,
        summary: t('aiSumApplyOps', { count: r.records?.length ?? 0 }),
      }
    }

    case 'set_speaker_notes': {
      const idx = Number(call.input.slideIndex)
      if (!slides[idx])
        return fail(t('aiFailSpeakerNotes'), `slideIndex out of range (0-${slides.length - 1})`)
      const text = String(call.input.text ?? '')
      const ok = await access.setSpeakerNotes?.(idx, text)
      if (!ok) return fail(t('aiFailSpeakerNotes'), 'Writing speaker notes failed')
      return {
        output: text
          ? `Wrote speaker notes for page ${idx + 1} (${text.length} characters).`
          : `Cleared speaker notes for page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumSpeakerNotes', { n: idx + 1 }),
      }
    }

    case 'delete_element': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      if (!slides[idx])
        return fail(t('aiFailDeleteElement'), `slideIndex out of range (0-${slides.length - 1})`)
      // Deletion is top-level only: for group members guide to ungroup instead of a misleading "not found"
      const target = resolveEditTarget(slides[idx]!, sourceId)
      if (target && ('nested' in target || target.groupId)) {
        const gid = 'nested' in target ? undefined : target.groupId
        return fail(
          t('aiFailDeleteElement'),
          `Element ${sourceId} is inside a group${gid ? ` (${gid})` : ''}; call ungroup_element on the group first and then delete it, or delete the whole group`,
        )
      }
      const updated = await window.slidesApi.deleteElement({ slideIndex: idx, sourceId })
      if (!updated)
        return fail(
          t('aiFailDeleteElement'),
          `Element ${sourceId} not found on page ${idx + 1} (e_* ids are durable across edits/saves; call read_slide when in doubt)`,
        )
      access.applySlide(idx, updated)
      return {
        output: `Deleted element ${sourceId} from page ${idx + 1}.`,
        mutated: true,
        summary: t('aiSumDeleteElement', { n: idx + 1 }),
      }
    }

    case 'ungroup_element': {
      const idx = Number(call.input.slideIndex)
      const sourceId = String(call.input.sourceId ?? '')
      const slide = slides[idx]
      if (!slide)
        return fail(t('aiFailUngroup'), `slideIndex out of range (0-${slides.length - 1})`)
      const node = slide.nodes.find((n) => n.sourceId === sourceId)
      if (!node) {
        return fail(
          t('aiFailUngroup'),
          findNodeById(slide.nodes, sourceId)
            ? `${sourceId} is inside another group; ungroup the outer group first`
            : `Element ${sourceId} not found on page ${idx + 1}`,
        )
      }
      if (node.type !== 'group')
        return fail(t('aiFailUngroup'), `${sourceId} is not a group (type: ${node.type})`)
      if (node.decoration)
        return fail(t('aiFailUngroup'), `${sourceId} is a layout decoration, read-only`)
      const updated = await window.slidesApi.ungroupElement({ slideIndex: idx, sourceId })
      if (!updated) return fail(t('aiFailUngroup'), 'Ungroup failed')
      access.applySlide(idx, updated)
      // Ungrouping rewrites the page and re-ids every element; echo the fresh list so no extra read_slide is needed
      const fresh = collectNodeInfos(updated.nodes)
        .map((n) => `${n.id} | ${n.type}${n.text ? ` | ${preview(n.text)}` : ''}`)
        .join('\n')
      return {
        output: `Ungrouped ${sourceId} on page ${idx + 1} into ${node.children.length} top-level elements. All element ids on this page changed; current elements:\n${fresh}`,
        mutated: true,
        summary: t('aiSumUngroup', { n: idx + 1 }),
      }
    }

    case 'save_style_template': {
      const name = String(call.input.name ?? '').trim()
      if (!name) return fail(t('aiFailSaveTemplate'), 'name must not be empty')
      if (!access.saveStyleTemplate)
        return fail(
          t('aiFailSaveTemplate'),
          'The current environment does not support template saving',
        )
      const styleSkillToSave = state?.lastStyleSkill ?? ''
      const topicToSave = state?.lastTopic ?? ''
      if (!styleSkillToSave)
        return fail(
          t('aiFailSaveTemplate'),
          'The current deck has no Style Skill to save (generate a presentation with generate_deck first)',
        )
      const r = await access.saveStyleTemplate(name, {
        topic: topicToSave,
        styleSkill: styleSkillToSave,
        createdAt: new Date().toISOString(),
      })
      if (!r.ok) return fail(t('aiFailSaveTemplate'), r.error ?? 'Save failed')
      return {
        output: `Saved the style "${name}" as a template; next time pass style_template:"${name}" to reuse it directly.`,
        mutated: false,
        summary: t('aiSumSaveTemplate', { name }),
      }
    }

    case 'list_style_templates': {
      if (!access.listStyleTemplates)
        return fail(
          t('aiFailListTemplates'),
          'The current environment does not support template listing',
        )
      const templates = await access.listStyleTemplates()
      if (templates.length === 0) {
        return {
          output:
            'No saved style templates yet. After generating a deck, call save_style_template(name) to save the current style.',
          mutated: false,
          summary: t('aiSumTemplatesEmpty'),
        }
      }
      const lines = templates.map(
        (t) => `- ${t.name} (topic: ${t.topic || 'unknown'}, saved ${t.createdAt.slice(0, 10)})`,
      )
      return {
        output: `Saved style templates (${templates.length}):\n${lines.join('\n')}\n\nPass style_template:"<template name>" to generate_deck to reuse that style directly.`,
        mutated: false,
        summary: t('aiSumListTemplates', { count: templates.length }),
      }
    }

    default:
      return fail(call.name, `Unknown tool: ${call.name}`)
  }
}
