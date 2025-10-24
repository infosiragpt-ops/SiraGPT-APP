
"use client"



// Enhanced AI Service
export class AIService {

  async classifyIntent(prompt: string): Promise<string> {
    const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
    if (!apiKey) {
      console.error("OpenAI API key not found for intent classification.");
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

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/proxy/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are an expert at classifying user intent. Analyze the user's prompt (which could be in any language) and classify it into one of these categories: 'gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'chart', 'webdev', or 'text'.

- 'gmail': Sending, reading, or managing emails. Examples: "send an email to hamza", "read my last 5 emails", "enviar un correo electrónico".
- 'google_services': Interacting with Google Calendar or Drive. Examples: "show my meetings for tomorrow", "find my marketing presentation on Drive", "mostrar mis eventos del calendario", "busca mi reporte de ventas en Drive".
- 'web_search': Finding information on the internet. Examples: "who is the president of France?", "what is the weather today?", "¿quién es el presidente de Francia?".
- 'image': Generating images.
- 'video': Generating videos.
- 'ppt': Creating presentations.
- 'chart': Creating charts or graphs.
- 'webdev': Building websites or UI components.
- 'text': For all other general conversation, questions, and text generation.


IMPORTANT: 
    - Only classify as 'webdev' if the user is **creating** or **building** a UI or web page. If the request involves **debugging**, **explaining**, or **reviewing code**, classify it as 'text'.
    - If the user asks for **specific languages** (e.g., "HTML", "React", "CSS"), check if the request is related to **building** a UI. If yes, classify as 'webdev'.
    - If the user is asking for a general explanation of something (e.g., "What is React?"), classify as 'text'.
    
Examples:
- "Design a dark mode developer portfolio" → 'webdev' (web development)
- "Create a React component" → 'webdev' (web development) 
- "Build a landing page" → 'webdev' (web development)
- "Make me a website for my business" → 'webdev' (web development)
- "Create HTML/CSS for a login form" → 'webdev' (web development)
- "encuentra mi presentación de marketing del último trimestre en Drive" → 'google_services'
- "Generate an image of a cat" → 'image' (visual content)
- "Create a logo design" → 'image' (visual design)
- "Make a video of sunset" → 'video' (video content)
- "Explain how React works" → 'text' (explanation)
- "What is JavaScript?" → 'text' (question)
Respond with only one word.

`,
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 10,
          temperature: 0,
        }),
      });

      if (!response.ok) throw new Error(`API error: ${response.statusText}`);
      const data = await response.json();
      const intent = data.choices[0].message.content.toLowerCase().trim();

      const validIntents = ['gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'chart', 'webdev', 'text'];
      if (validIntents.includes(intent)) {
        return intent;
      }
      return 'text'; // Default fallback
    } catch (error) {
      console.error("Intent classification failed:", error);
      return 'text'; // Default on error
    }
  }
}

export const aiService = new AIService()
