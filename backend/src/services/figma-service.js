const { OpenAI } = require('openai');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class FigmaService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
        this.figmaApiKey = process.env.FIGMA_API_KEY;
        this.figmaApiUrl = 'https://api.figma.com/v1';
    }

    /**
     * Generate Mermaid flowchart code from user prompt using AI
     */
    async generateMermaidCode(prompt, conversationHistory = []) {
        try {
            const systemPrompt = `You are an expert at creating Mermaid diagrams. 
Based on the user's request, generate the appropriate Mermaid syntax.
You can create:
- Flowcharts
- Sequence diagrams
- Gantt charts
- Class diagrams
- Git graphs
- And more.

Analyze the user's prompt to determine the best diagram type.

**Flowchart Example:**
\`\`\`mermaid
flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E
\`\`\`

**Sequence Diagram Example:**
\`\`\`mermaid
sequenceDiagram
    participant User
    participant Server
    User->>Server: Request Data
    Server-->>User: Return Data
\`\`\`

Generate ONLY the Mermaid code, no explanations.`;

            const messages = [
                { role: 'system', content: systemPrompt },
                ...conversationHistory.slice(-5).map(msg => ({
                    role: msg.role === 'USER' ? 'user' : 'assistant',
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                })),
                { role: 'user', content: prompt }
            ];

            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages,
                temperature: 0.3,
                max_tokens: 1000,
            });

            let mermaidCode = response.choices[0].message.content.trim();
            
            // Extract Mermaid code from markdown code blocks if present
            const mermaidMatch = mermaidCode.match(/```(?:mermaid)?\s*([\s\S]*?)```/);
            if (mermaidMatch) {
                mermaidCode = mermaidMatch[1].trim();
            }

            return mermaidCode;
        } catch (error) {
            console.error('Error generating Mermaid code:', error);
            throw new Error('Failed to generate flowchart code');
        }
    }

    /**
     * Create a Figma file with the flowchart
     * Note: Figma API doesn't support direct file creation via API
     * This is a placeholder for future implementation
     * For now, we'll use Mermaid Live Editor for editing
     */
    async createFigmaFile(mermaidCode, title = 'Flowchart') {
        // Note: Figma API doesn't support creating files via POST
        // To create actual Figma files, you would need to:
        // 1. Use Figma Plugin API
        // 2. Or manually create files and use file keys
        // For now, we'll return null and use Mermaid Live Editor instead
        
        // If user has Figma API key, they can manually create files
        // and we can provide instructions
        
        return null;
    }

    /**
     * Generate flowchart diagram
     * Returns Mermaid code and optional Figma file info
     */
    async generateFlowchart(prompt, conversationHistory = [], userId = null) {
        try {
            // Generate Mermaid code
            const mermaidCode = await this.generateMermaidCode(prompt, conversationHistory);
            
            // Try to create Figma file (optional)
            let figmaFile = null;
            if (this.figmaApiKey) {
                figmaFile = await this.createFigmaFile(mermaidCode, `Flowchart: ${prompt.substring(0, 50)}`);
            }

            return {
                mermaidCode,
                figmaFile,
                // For embedding, we'll use Mermaid Live Editor or render it client-side
                embedUrl: this.generateMermaidEmbedUrl(mermaidCode),
                title: `Flowchart: ${prompt.substring(0, 50)}`
            };
        } catch (error) {
            console.error('Error generating flowchart:', error);
            throw error;
        }
    }

    /**
     * Generate Mermaid Live Editor URL for embedding
     */
    generateMermaidEmbedUrl(mermaidCode) {
        // Create a JSON payload compatible with Mermaid Live Editor
        const payload = {
            code: mermaidCode,
            mermaid: { theme: 'default' },
        };
        
        // Encode the JSON payload to Base64
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');

        return `https://mermaid.live/edit#base64:${encodedPayload}`;
    }

    /**
     * Alternative: Use a service to render Mermaid to image
     */
    async renderMermaidToImage(mermaidCode) {
        try {
            // Using Mermaid.ink API to render Mermaid to image
            const encoded = Buffer.from(mermaidCode).toString('base64url');
            const imageUrl = `https://mermaid.ink/img/${encoded}`;
            
            return imageUrl;
        } catch (error) {
            console.error('Error rendering Mermaid to image:', error);
            return null;
        }
    }
}

module.exports = new FigmaService();
