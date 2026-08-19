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
            const systemPrompt = `You are a world-class expert in creating complex and visually appealing Mermaid diagrams.
Your task is to generate Mermaid syntax based on the user's request. Do not provide any explanations, only the code.

**Capabilities:**
- **Flowcharts:** For processes and workflows. Use different shapes for different types of actions (e.g., rectangles for processes, diamonds for decisions, circles for start/end). Use subgraphs for complex sections.
- **Sequence Diagrams:** For interactions between systems or components.
- **Gantt Charts:** For project timelines.
- **Class Diagrams:** For object-oriented programming structures.
- **State Diagrams:** For object states and transitions.
- **ER Diagrams:** For database schemas.
- **User Journey Diagrams:** To map user experiences.
- **Git Graphs:** To visualize git branching.

**Instructions for Quality:**
1.  **Analyze the Request:** Carefully understand the user's prompt to select the most appropriate diagram type. For complex requests, break down the problem and represent it logically.
2.  **Layout Preference:** For flowcharts, prefer a top-down layout (flowchart TD) as the default. Only use left-to-right (LR) if specifically requested or if the diagram is extremely wide. This is crucial for readability on standard screens.
3.  **Use Advanced Features:** Don't stick to basic syntax. Employ subgraphs, different arrow types, and comments where necessary to improve clarity.
4.  **Styling:** Apply styling to make the diagrams more readable and professional. Use 'classDef' to define styles for nodes (e.g., colors, borders). Assign classes to nodes using ':::' operator.
5.  **Complexity:** For complex prompts, generate a detailed and comprehensive diagram. Don't oversimplify.

**Vertical Flowchart Example (Preferred):**
\`\`\`mermaid
flowchart TD
    subgraph "User Authentication"
        A[Start] --> B{User Logged In?};
        B -- No --> C[Show Login Page];
        C --> D{Credentials Valid?};
        D -- Yes --> E[Redirect to Dashboard];
        D -- No --> C;
        B -- Yes --> E;
    end
    
    subgraph "Dashboard"
        E --> F[Load User Data];
        F --> G[Display Widgets];
    end

    E --> H[End];

    classDef start-end fill:#f9f,stroke:#333,stroke-width:2px;
    classDef decision fill:#ccf,stroke:#333,stroke-width:2px;
    class A,H start-end;
    class B,D decision;
\`\`\`

**Sequence Diagram Example:**
    subgraph "User Authentication"
        A[Start] --> B{User Logged In?};
        B -- No --> C[Show Login Page];
        C --> D{Credentials Valid?};
        D -- Yes --> E[Redirect to Dashboard];
        D -- No --> C;
        B -- Yes --> E;
    end
    
    subgraph "Dashboard"
        E --> F[Load User Data];
        F --> G[Display Widgets];
    end

    E --> H[End];

    classDef start-end fill:#f9f,stroke:#333,stroke-width:2px;
    classDef decision fill:#ccf,stroke:#333,stroke-width:2px;
    class A,H start-end;
    class B,D decision;
\`\`\`

**Sequence Diagram Example:**
\`\`\`mermaid
sequenceDiagram
    participant U as User
    participant A as App
    participant S as Server
    participant DB as Database

    U->>A: Clicks "Login"
    A->>S: POST /login (username, password)
    S->>DB: SELECT user WHERE username = ?
    DB-->>S: User record
    S-->>A: { token: "..." }
    A-->>U: Redirect to Dashboard
\`\`\`

Generate ONLY the Mermaid code block.`;

            const messages = [
                { role: 'system', content: systemPrompt },
                ...conversationHistory.slice(-5).map(msg => ({
                    role: msg.role === 'USER' ? 'user' : 'assistant',
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                })),
                { role: 'user', content: prompt }
            ];

            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o',
                messages,
                temperature: 0.5,
                max_tokens: 2000,
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
            // Using Mermaid.ink API to render Mermaid to image with a transparent background
            const encoded = Buffer.from(mermaidCode).toString('base64url');
            const imageUrl = `https://mermaid.ink/img/${encoded}?bgColor=transparent`;

            return imageUrl;
        } catch (error) {
            console.error('Error rendering Mermaid to image:', error);
            return null;
        }
    }
}

module.exports = new FigmaService();
