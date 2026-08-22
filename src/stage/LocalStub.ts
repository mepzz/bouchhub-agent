// src/stage/LocalStub.ts

import { Provider } from './Provider';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * LocalStub: A non-networked provider that composites local furniture assets
 * onto detected floor spaces within the input image. No API keys or external
 * requests are made.
 */
export class LocalStub implements Provider {
  getName(): string {
    return 'LocalStub';
  }

  async generate(image: Buffer, prompt: string, mask?: Buffer): Promise<Buffer> {
    // 1. Load a base furniture asset
    // In a real implementation, we'd use a library like Jimp to detect floor space.
    // Here, we simulate detection by placing assets over the center-bottom quadrant.
    const assetsDir = path.join(os.homedir(), 'Desktop', 'assets', 'furniture');
    const assetFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.png'));
    const randomAsset = path.join(assetsDir, assetFiles[Math.floor(Math.random() * assetFiles.length)]);

    // 2. Simple composite logic
    // For this stub, we just copy the asset into a temp file next to the input.
    // A real engine would use OpenCV or similar to blend the mask.
    const outputDir = path.join('deliverables', 'sta', 'outputs');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const outputFileName = `local_stub_${Date.now()}.png`;
    const outputPath = path.join(outputDir, outputFileName);

    // Copy asset to output (simulating composition where asset is overlaid)
    fs.copyFileSync(randomAsset, outputPath);

    return fs.readFileSync(outputPath);
  }
}
