
"use client"

export interface IntentAnalysis {
  type: "search_tracks" | "search_artists" | "search_playlists" | "get_recommendations" | "general"
  query: string
  confidence: number
}

// Enhanced AI Service
export class AIService {
  private apiKey: string = process.env.NEXT_PUBLIC_OPENAI_API_KEY || ""


  //   async classifyIntent(prompt: string, conversationHistory: any[] = []): Promise<string> {
  //     const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  //     if (!apiKey) {
  //       console.error("OpenAI API key not found for intent classification.");
  //       // Fallback to basic keyword matching
  //       const lowerCasePrompt = prompt.toLowerCase();
  //       if (/\b(gmail|email|mail|send to|compose)\b/i.test(lowerCasePrompt)) return 'gmail';
  //       if (/\b(calendar|event|meeting|schedule|drive|file|document|folder)\b/i.test(lowerCasePrompt)) return 'google_services';
  //       if (/\b(search|find|who is|what is|when is|tell me about)\b/i.test(lowerCasePrompt)) return 'web_search';
  //       if (/\b(image|photo|picture|drawing|logo)\b/i.test(lowerCasePrompt)) return 'image';
  //       if (/\b(video|clip|animation|movie)\b/i.test(lowerCasePrompt)) return 'video';
  //       if (/\b(ppt|presentation|slides)\b/i.test(lowerCasePrompt)) return 'ppt';
  //       if (/\b(chart|graph|diagram)\b/i.test(lowerCasePrompt)) return 'chart';
  //       if (/\b(website|webpage|html|css|javascript)\b/i.test(lowerCasePrompt)) return 'webdev';
  //       return 'text';
  //     }

  //     const history = conversationHistory
  //       .slice(-10) // Get the last 10 messages
  //       .map(msg => `${msg.role}: ${msg.content}`)
  //       .join('\n');

  //     try {
  //       const response = await fetch("https://api.openai.com/v1/chat/completions", {
  //         method: "POST",
  //         headers: {
  //           "Content-Type": "application/json",
  //           "Authorization": `Bearer ${apiKey}`
  //         },
  //         body: JSON.stringify({
  //           model: "gpt-3.5-turbo",
  //           messages: [
  //             {
  //               role: "system",
  //               content: `You are an expert at classifying user intent. Analyze the user's prompt (which could be in any language including Roman Urdu, Urdu, English, German, Spanish, etc.) and classify it into one of these categories: 'gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'chart', 'webdev', or 'text'.

  // - 'gmail': Sending, reading, or managing emails. Examples: "send an email to hamza", "read my last 5 emails", "enviar un correo electrónico".
  // - 'google_services': Interacting with Google Calendar or Drive. Examples: "show my meetings for tomorrow", "find my marketing presentation on Drive", "mostrar mis eventos del calendario".
  // - 'web_search': Finding information on the internet. Examples: "who is the president of France?", "what is the weather today?", "¿quién es el presidente de Francia?".
  // - 'image': Generating images. Examples: "create an image of a sunset", "genera una imagen de un gato".
  // - 'video': Generating videos. Examples: "make a video of a beach", "crea un video de la ciudad".
  // - 'ppt': Creating PowerPoint presentations. Examples in multiple languages:
  //   * English: "create a presentation about AI", "make a PPT on climate change", "generate slides about marketing"
  //   * Roman Urdu: "AI ke bare mein presentation banao", "PPT banao machine learning par", "climate change par slides bana do"
  //   * Urdu: "مصنوعی ذہانت کے بارے میں پریزنٹیشن بنائیں", "پی پی ٹی بناؤ", "سلائیڈز تیار کرو"
  //   * German: "erstelle eine Präsentation über KI", "mach eine PPT zum Klimawandel"
  //   * Spanish: "crea una presentación sobre IA", "haz un PPT sobre el clima"
  //   * French: "crée une présentation sur l'IA", "génère des slides"
  // - 'chart': Creating charts or graphs. Examples: "create a bar chart", "make a pie graph".
  // - 'webdev': Building websites or UI components. Examples: "build a login page", "create a React component".
  // - 'text': For all other general conversation, questions, and text generation.


  // IMPORTANT: 
  //     - Consider the conversation history for context. A simple "yes" might mean "yes, create the website we just discussed."
  //     - - Only classify as 'webdev' if the user is **creating** or **building** a UI or web page. If the request involves **debugging**, **explaining**, or **reviewing code**, classify it as 'text'.
  //     - If the user asks for **specific languages** (e.g., "HTML", "React", "CSS"), check if the request is related to **building** a UI. If yes, classify as 'webdev'.
  //     - If the user is asking for a general explanation of something (e.g., "What is React?"), classify as 'text'.
  //    analyze with the intent of so that easy to understand intent what user talk about Conversation History:\n${history}
  // Respond with only one word.`,
  //             },
  //             { role: "user", content: prompt },
  //           ],
  //           temperature: 0.2,
  //         }),
  //       });

  //       if (!response.ok) throw new Error(`API error: ${response.statusText}`);
  //       const data = await response.json();
  //       const intent = data.choices[0].message.content.toLowerCase().trim();
  //       console.log('intent FROM OPEN AI', intent);

  //       const validIntents = ['gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'chart', 'webdev', 'text'];
  //       if (validIntents.includes(intent)) {
  //         return intent;
  //       }
  //       return 'text'; // Default fallback
  //     } catch (error) {
  //       console.error("Intent classification failed:", error);
  //       return 'text'; // Default on error
  //     }
  //   }


  async analyzeIntent(prompt: string) {

    console.error("Dummy Intent.");
    // Fallback to basic keyword matching
    const lowerCasePrompt = prompt.toLowerCase();
    if (/\b(gmail|email|mail|send to|compose)\b/i.test(lowerCasePrompt)) return 'gmail';
    if (/\b(calendar|event|meeting|schedule|drive|file|document|folder)\b/i.test(lowerCasePrompt)) return 'google_services';
    if (/\b(search|find|who is|what is|when is|tell me about)\b/i.test(lowerCasePrompt)) return 'web_search';
    if (/\b(image|photo|picture|drawing|logo)\b/i.test(lowerCasePrompt)) return 'image';
    if (/\b(video|clip|animation|movie)\b/i.test(lowerCasePrompt)) return 'video';
    if (/\b(ppt|presentation|slides)\b/i.test(lowerCasePrompt)) return 'ppt';
    if (/\b(chart|graph|diagram)\b/i.test(lowerCasePrompt)) return 'chart';

    if (/\b(website|webpage|html|css|javascript)\b/i.test(lowerCasePrompt)) return 'webdev';
    return 'text';

  }

  async classifyIntent(
    prompt: string,
    conversationHistory: any[] = [],
    signal?: AbortSignal
  ): Promise<string> {

    // const intent = await this.analyzeIntent(prompt);
    // if (intent) {
    //   return intent;
    // }

    try {

      const messages = [
        {
          role: "system",
          content: `You are an expert at classifying user intent. Analyze the user's prompt (which could be in any language including Roman Urdu, Urdu, English, German, Spanish, etc.) and classify it into one of these categories: 'gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'chart', 'webdev', or 'text'.

- 'gmail': Sending, reading, or managing emails. Examples: "send an email to hamza", "read my last 5 emails", "enviar un correo electrónico".
- 'google_services': Interacting with Google Calendar or Drive. Examples: "show my meetings for tomorrow", "find my marketing presentation on Drive", "mostrar mis eventos del calendario".
- 'web_search': Finding information on the internet. Examples: "who is the president of France?", "what is the weather today?", "¿quién es el presidente de Francia?".
- 'image': Generating images. Examples: "create an image of a sunset", "genera una imagen de un gato".
- 'video': Generating videos. Examples: "make a video of a beach", "crea un video de la ciudad".
- 'ppt': Creating PowerPoint presentations. Examples in multiple languages:
* English: "create a presentation about AI", "make a PPT on climate change", "generate slides about marketing"
* Roman Urdu: "AI ke bare mein presentation banao", "PPT banao machine learning par", "climate change par slides bana do"
* Urdu: "مصنوعی ذہانت کے بارے میں پریزنٹیشن بنائیں", "پی پی ٹی بناؤ", "سلائیڈز تیار کرو"
* German: "erstelle eine Präsentation über KI", "mach eine PPT zum Klimawandel"
* Spanish: "crea una presentación sobre IA", "haz un PPT sobre el clima"
* French: "crée une présentation sur l'IA", "génère des slides"
- 'chart': Creating charts or graphs. Examples: "create a bar chart", "make a pie graph".

- 'webdev': Building websites or UI components. Examples: "build a login page", "create a React component".
- 'text': For all other general conversation, questions, and text generation. 
  This includes structured text outputs such as tables, dummy data, formatted lists, or code-generated textual data.
  If the user asks to create a "table", "list", "dataset", or "dummy data" without explicitly mentioning charts, slides, or presentations, classify as 'text'.

IMPORTANT: 
- Only classify as 'webdev' if the user is **creating** or **building** a UI or web page. If the request involves **debugging**, **explaining**, or **reviewing code**, classify it as 'text'.
- If the user asks for **specific languages** (e.g., "HTML", "React", "CSS"), check if the request is related to **building** a UI. If yes, classify as 'webdev'.
- If the user is asking for a general explanation of something (e.g., "What is React?"), classify as 'text'.
- one more if user ask for website so create carefully detect what user want not give any developing or code detect as webdev first analyze what user want sometime they want another language code for example they want a python code so give them that code that not a webssdev.

Examples:
- "Design a dark mode developer portfolio" → 'webdev' (web development)
 
- "Build a landing page" → 'webdev' (web development)
- "Make me a website for my business" → 'webdev' (web development)
- "Create HTML/CSS for a login form" → 'webdev' (web development)
- "encuentra mi presentación de marketing del último trimestre en Drive" → 'google_services'
- "Generate an image of a cat" → 'image' (visual content)
- "Create a logo design" → 'image' (visual design)
- "Make a video of sunset" → 'video' (video content)
- "Explain how React works" → 'text' (explanation)
- "What is JavaScript?" → 'text' (question)
- "Creating Word document or file" => text
Respond with only one word.

`,
        }
      ];

      if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
        const recentMessages = conversationHistory.slice(-2);
        for (const msg of recentMessages) {
          const role = msg.role === "USER" ? "user" : "assistant";
          const textPart = Array.isArray(msg.content)
            ? msg.content.find((c: any) => c.type === "text")?.text || ""
            : msg.content;
          messages.push({ role, content: textPart });
        }
      }

      // ✅ Finally add the new user prompt
      messages.push({ role: "user", content: prompt });

      // const response = await fetch("https://api.openai.com/v1/chat/completions", {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/proxy/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages,
          }),
          // Allow caller to abort the request (used by Stop button)
          signal,
        }
      );

      if (!response.ok) throw new Error(`API error: ${response.statusText}`);
      const data = await response.json();
      const intent = data.choices[0].message.content.toLowerCase().trim();
      console.log('intent FROM OPEN AI', intent);

      const validIntents = ['gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'chart', 'webdev', 'text'];
      if (validIntents.includes(intent)) {
        return intent;
      }
      return 'text'; // Default fallback
    } catch (error: any) {
      // If this was explicitly aborted (e.g. user pressed Stop), don't try to
      // recover or return any fallback intent. Let caller decide what to do.
      if (error?.name === 'AbortError') {
        throw error;
      }

      console.error("Intent classification failed:", error);
      const fallbackIntent = await this.analyzeIntent(prompt);
      return fallbackIntent || 'text';
    }
  }
}

export const aiService = new AIService()
