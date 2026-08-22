// src/stage/ApiAdapter.ts

import { Provider } from './Provider';

/**
 * ApiAdapter: An adapter interface for external image-editing APIs (e.g., OpenAI).
 * Currently never called as per requirements.
 */
export class ApiAdapter implements Provider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getName(): string {
    return 'ApiAdapter';
  }

  async generate(image: Buffer, prompt: string, mask?: Buffer): Promise<Buffer> {
    // Implementation would involve fetch() to the API endpoint
    // This method is intentionally left unimplemented to satisfy 'never called' requirement.
    throw new Error('ApiAdapter is ready but never called in this pipeline configuration.');
  }
}
