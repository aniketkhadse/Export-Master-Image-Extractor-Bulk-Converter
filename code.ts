/**
 * code.ts - FREEWARE VERSION
 * * This is the main plugin thread, now completely free and focused on performance.
 */

// --- CONFIGURATION ---
const CONFIG = {
    BATCH_SIZE: 10,
    SCAN_CHUNK_SIZE: 100,
    UPDATE_INTERVAL_MS: 100,
    // Increased from 50MB to 100MB to reduce "failed to fetch" errors for large assets
    MAX_FILE_SIZE: 100 * 1024 * 1024, 
    MIN_ETA_SAMPLES: 5,
    // NEW CONFIG: Retry attempts for fetching image bytes
    MAX_RETRY_ATTEMPTS: 3, 
    RETRY_DELAY_MS: 100, // Reduced delay for main thread stability
};

// --- SHOW UI ---
figma.showUI(__html__, {
    width: 360,
    height: 640,
    themeColors: true,
    title: "Export Master: Image Extractor (FREE)",
});

// --- INTERFACES ---
interface FoundImageInfo {
    hash: string;
    name: string;
    frame: string;
}

interface FetchedImageInfo {
    hash: string;
    name: string;
    frame: string;
    bytes: Uint8Array;
    format: "JPG" | "PNG" | "WEBP" | "GIF" | "bin";
    size: number;
    width: number;
    height: number;
}

// --- MANAGERS ---

// No EntitlementManager needed, the plugin is free.

class OperationManager {
    private id: number = 0;
    private cancelled: boolean = false;

    start(): number {
        this.id = Date.now();
        this.cancelled = false;
        return this.id;
    }

    cancel() {
        this.cancelled = true;
    }

    isActive(opId: number): boolean {
        return !this.cancelled && this.id === opId;
    }
}

// --- GLOBALS ---
const currentOperation = new OperationManager();
let foundImages: FoundImageInfo[] = []; // Cache scan results

// --- MAIN MESSAGE HANDLER ---
let uiReady = false;

figma.ui.onmessage = async (msg: any) => {
    try {
        // 🔥 FIX: UI tells plugin it is fully loaded
        if (msg.type === "ui-ready") {
            uiReady = true;
            return;
        }

        switch (msg.type) {

            case "init-plugin":
                // Wait until UI is definitely ready before sending any message
                while (!uiReady) {
                    await new Promise(r => setTimeout(r, 10));
                }

                sendSelectionInfo();
                break;

            case "scan-images":
                const scanOpId = currentOperation.start();
                await scanImages(msg.scanMode, scanOpId);
                break;

            case "download-images":
                // Wait until UI is ready before sending any response
                while (!uiReady) {
                    await new Promise(r => setTimeout(r, 10));
                }

                const dlOpId = currentOperation.start();
                await fetchImageBytes(msg.images, dlOpId, msg);
                break;

            case "download-success":
                break;

            case "cancel-operation":
                currentOperation.cancel();
                figma.ui.postMessage({ type: "operation-cancelled" });
                break;
        }
    } catch (error) {
        figma.ui.postMessage({
            type: "error",
            message: getUserFriendlyError(error),
        });
    }
};


// --- EVENT LISTENERS ---
figma.on("selectionchange", sendSelectionInfo);
figma.on("close", () => currentOperation.cancel());

// --- CORE FUNCTIONS ---

function sendSelectionInfo() {
    const selection = figma.currentPage.selection;
    figma.ui.postMessage({
        type: "selection-changed",
        count: selection.length,
    });
}

const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function scanImages(scanMode: "entire" | "selected", operationId: number) {
    if (!currentOperation.isActive(operationId)) return;

    figma.ui.postMessage({
        type: "scan-progress",
        phase: "Starting scan...",
        progress: 0,
        current: 0,
        total: 100,
    });

    const uniqueImages = new Map<string, FoundImageInfo>();
    const existingNames = new Set<string>();
    let scannedCount = 0;

    let startNodes: readonly SceneNode[];
    if (scanMode === "selected") {
        startNodes = figma.currentPage.selection;
        if (startNodes.length === 0) {
            throw new Error("No frames selected. Please select frames first.");
        }
    } else {
        startNodes = figma.currentPage.children;
    }

    let stack: SceneNode[] = [...startNodes];
    let totalEstimated = startNodes.length * 5; 
    let lastUpdateTime = Date.now();

    while (stack.length > 0) {
        if (!currentOperation.isActive(operationId)) return;

        const chunkLimit = Math.min(stack.length, CONFIG.SCAN_CHUNK_SIZE);
        let nodesToProcess: SceneNode[] = [];
        for (let i = 0; i < chunkLimit; i++) {
            nodesToProcess.push(stack.pop()!);
        }

        for (const node of nodesToProcess) {
            scannedCount++;
            checkNodeForImages(node, uniqueImages, existingNames, operationId);
            if ("children" in node) {
                for (let j = node.children.length - 1; j >= 0; j--) {
                    stack.push(node.children[j]);
                }
                totalEstimated += node.children.length;
            }
        }

        const now = Date.now();
        if (now - lastUpdateTime > CONFIG.UPDATE_INTERVAL_MS) {
            figma.ui.postMessage({
                type: "scan-progress",
                phase: `Scanning... (${uniqueImages.size} found)`,
                progress: Math.min(95, (scannedCount / totalEstimated) * 100),
                current: scannedCount,
                total: "many",
            });
            await yieldToMain();
            lastUpdateTime = now;
        }
    }

    foundImages = Array.from(uniqueImages.values());
    if (currentOperation.isActive(operationId)) {
        figma.ui.postMessage({
            type: "scan-complete",
            images: foundImages,
        });
    }
}

function checkNodeForImages(
    node: SceneNode,
    uniqueImages: Map<string, FoundImageInfo>,
    existingNames: Set<string>,
    operationId: number
) {
    if (!currentOperation.isActive(operationId)) return;

    const processPaint = (paint: Paint) => {
        if (paint.type === "IMAGE" && paint.imageHash) {
            addUniqueImage(paint.imageHash, node, uniqueImages, existingNames, operationId);
        }
    };
// --- IMAGE SAFETY CHECK FOR FILLS ---
if ("fills" in node && Array.isArray(node.fills)) {

    // Find real image fill
    const imgFill = node.fills.find(f => f.type === "IMAGE" && f.imageHash);

    if (!imgFill) {
        console.warn(`Skipping ${node.name}: No raster image in fills`);
        // Don't run processPaint — skip this node completely
    } else {
        // Now safe to process
        (node.fills as readonly Paint[]).forEach(processPaint);
    }
}

// --- IMAGE SAFETY CHECK FOR STROKES (optional) ---
if ("strokes" in node && Array.isArray(node.strokes)) {

    const imgStroke = node.strokes.find(f => f.type === "IMAGE" && f.imageHash);

    if (!imgStroke) {
        console.warn(`Skipping ${node.name}: No raster image in strokes`);
    } else {
        (node.strokes as readonly Paint[]).forEach(processPaint);
    }
}

}

function addUniqueImage(
    imageHash: string,
    node: SceneNode,
    uniqueImages: Map<string, FoundImageInfo>,
    existingNames: Set<string>,
    operationId: number
) {
    if (!currentOperation.isActive(operationId) || uniqueImages.has(imageHash))
        return;

    try {
        const baseName = sanitizeFileName(node.name) || "image";
        let uniqueName = baseName;
        let counter = 1;
        while (existingNames.has(uniqueName)) {
            uniqueName = `${baseName}_${counter++}`;
        }
        existingNames.add(uniqueName);

        let frameName = "Page";
        let parent: (BaseNode & { parent: BaseNode["parent"] }) | null = node;
        while (parent) {
            if (
                parent.type === "FRAME" ||
                parent.type === "COMPONENT" ||
                parent.type === "INSTANCE" ||
                parent.type === "COMPONENT_SET"
            ) {
                frameName = sanitizeFileName(parent.name);
                break; 
            }
            if (parent.type === "PAGE") break; 
            parent = parent.parent;
        }

        uniqueImages.set(imageHash, {
            hash: imageHash,
            name: uniqueName,
            frame: frameName,
        });
    } catch (error) {
        console.error("Error processing image name:", error);
    }
}

async function fetchImageBytes(
    images: FoundImageInfo[],
    operationId: number,
    msg: any
) {
    if (!currentOperation.isActive(operationId)) return;

    const total = images.length;
    let failedCount = 0;
    const startTime = Date.now();

    figma.ui.postMessage({
        type: "download-progress",
        phase: "Preparing...",
        progress: 0,
        current: 0,
        total: total,
    });

    figma.ui.postMessage({
        type: "download-start",
        downloadType: msg.downloadType,
        formats: msg.formats,
        renamePattern: msg.renamePattern,
        totalImages: total,
    });

    for (let i = 0; i < total; i += CONFIG.BATCH_SIZE) {
        if (!currentOperation.isActive(operationId))
            throw new Error("Operation cancelled");
        
        const batch = images.slice(i, i + CONFIG.BATCH_SIZE);
        const fetchedBatch: FetchedImageInfo[] = [];

        const results = await Promise.allSettled(
            batch.map(async (imgInfo) => {
                
                // --- NEW RETRY LOGIC START ---
                for (let attempt = 1; attempt <= CONFIG.MAX_RETRY_ATTEMPTS; attempt++) {
                    try {
                        const img = figma.getImageByHash(imgInfo.hash);
                        if (!img) throw new Error("Image not found in Figma document.");

                        const size = await img.getSizeAsync();
                        const bytes = await img.getBytesAsync();

                        if (bytes.length > CONFIG.MAX_FILE_SIZE)
                            throw new Error(`Image too large (> ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)`);
                        
                        const format = detectImageFormat(bytes);

                        return {
                            ...imgInfo,
                            bytes: bytes,
                            format: format,
                            size: bytes.length,
                            width: size.width,
                            height: size.height,
                        } as FetchedImageInfo;

                    } catch (e) {
                        const errorMsg = e instanceof Error ? e.message : String(e);
                        console.warn(`Attempt ${attempt} failed for image ${imgInfo.name}. Reason: ${errorMsg}`);
                        
                        if (attempt === CONFIG.MAX_RETRY_ATTEMPTS) {
                            // Re-throw the error on the final attempt to be caught by Promise.allSettled
                            throw new Error(`Failed to fetch after ${CONFIG.MAX_RETRY_ATTEMPTS} attempts: ${errorMsg}`);
                        }
                        
                        if (!currentOperation.isActive(operationId)) {
                             throw new Error("Operation cancelled during retry");
                        }
                        
                        // Wait before the next attempt
                        await delay(CONFIG.RETRY_DELAY_MS * attempt);
                    }
                }
                // This line should technically be unreachable, but TypeScript needs it.
                throw new Error("Exited retry loop without success.");
                // --- NEW RETRY LOGIC END ---
            })
        );

        results.forEach((res) => {
            if (res.status === "fulfilled") {
                fetchedBatch.push(res.value);
            } else {
                // Increment fail count and log for user notification
                failedCount++;
                console.error(`Failed to fetch image: ${res.reason.message}`);
            }
        });

        if (fetchedBatch.length > 0) {
            figma.ui.postMessage({
                type: "images-batch-ready",
                images: fetchedBatch,
            });
        }

        const processed = Math.min(i + CONFIG.BATCH_SIZE, total);
        figma.ui.postMessage({
            type: "download-progress",
            phase: "Fetching image data...",
            progress: (processed / total) * 100,
            current: processed,
            total: total,
            eta: calculateETA(processed, total, Date.now() - startTime),
        });
        
        // Add a yield here after the batch to ensure Figma remains responsive
        await yieldToMain();
    }

    if (failedCount > 0) {
        figma.notify(`Warning: ${failedCount} images failed to download or were too large, even after retries. Max size is ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB.`);
    }

    if (currentOperation.isActive(operationId)) {
        figma.ui.postMessage({
            type: "download-progress",
            phase: "Sending data to UI...",
            progress: 100,
            current: total - failedCount,
            total: total,
            eta: "Done"
        });

        figma.ui.postMessage({
            type: "download-finish",
        });
    }
}

// --- HELPER FUNCTIONS ---
function detectImageFormat(bytes: Uint8Array): FetchedImageInfo["format"] {
    if (!bytes || bytes.length < 4) return "bin";
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "PNG";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "JPG";
    if (bytes[0] === 0x52 && bytes[1] === 0x49) return "WEBP";
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return "GIF";
    return "bin"; 
}

function sanitizeFileName(name: string): string {
    return name
        ? name
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") 
            .trim()
            .substring(0, 255) || "image"
        : "image";
}

function calculateETA(current: number, total: number, elapsed: number): string {
    if (current < CONFIG.MIN_ETA_SAMPLES) return "Calculating...";
    const rate = current / elapsed;
    const remainingS = (total - current) / rate / 1000;
    if (remainingS < 1) return "~0s";
    if (remainingS < 60) return `~${Math.round(remainingS)}s`;
    return `~${Math.floor(remainingS / 60)}m ${Math.round(remainingS % 60)}s`;
}

function getUserFriendlyError(error: any): string {
    if (error instanceof Error) {
        // Return a cleaner error for the user
        if (error.message.includes("frames selected")) return "Please select the frames you want to scan, or switch to 'Entire Page' mode.";
        if (error.message.includes("Operation cancelled")) return "The operation was manually cancelled.";
        return error.message;
    }
    return String(error);
}