// src/stage/Provider.ts

/**
 * Core interface for image generation/editing providers.
 */
export interface Provider {
  /**
   * Generates or edits an image.
   * @param image - The input image buffer.
   * @param prompt - Textual description of the desired change.
   * @param mask - Optional buffer for regions to edit (image editing).
   * @returns The resulting image buffer.
   */
  generate(image: Buffer, prompt: string, mask?: Buffer): Promise<Buffer>;

  /**
   * Returns the provider name.
   */
  getName(): string;
}
