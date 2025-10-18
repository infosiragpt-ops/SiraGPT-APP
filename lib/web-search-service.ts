// "use client"

// export interface SearchResult {
//   title: string
//   url: string
//   snippet: string
// }

// export interface WebSearchService {
//   search: (query: string) => Promise<SearchResult[]>
// }

// class WebSearchServiceImpl implements WebSearchService {
//   async search(query: string): Promise<SearchResult[]> {
//     try {
//       // In a real implementation, you'd use a search API like Google Custom Search, Bing, or SerpAPI
//       // For demo purposes, we'll simulate search results
//       await new Promise((resolve) => setTimeout(resolve, 1000))

//       const mockResults: SearchResult[] = [
//         {
//           title: `${query} - Wikipedia`,
//           url: `https://en.wikipedia.org/wiki/${encodeURIComponent(query)}`,
//           snippet: `Learn about ${query} on Wikipedia. Comprehensive information and references.`,
//         },
//         {
//           title: `${query} - Latest News`,
//           url: `https://news.google.com/search?q=${encodeURIComponent(query)}`,
//           snippet: `Latest news and updates about ${query} from various sources.`,
//         },
//         {
//           title: `${query} - Research Papers`,
//           url: `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`,
//           snippet: `Academic papers and research related to ${query}.`,
//         },
//       ]

//       return mockResults
//     } catch (error) {
//       console.error("Error performing web search:", error)
//       throw new Error("Failed to perform web search")
//     }
//   }
// }

// export const webSearchService = new WebSearchServiceImpl()

// "use client"

// import { apiClient } from "./api"

// export interface SearchResult {
//   title: string
//   url: string
//   snippet: string
//   displayLink?: string
// }

// export interface WebSearchService {
//   search: (query: string, chatId?: string) => Promise<{ results: SearchResult[]; content: string }>
// }

// class WebSearchServiceImpl implements WebSearchService {
//   async search(query: string, chatId?: string): Promise<{ results: SearchResult[]; content: string }> {
//     try {
//       // Call the backend web search API
//       const response = await apiClient.webSearch({ query, chatId });

//       return {
//         results: response.results || [],
//         content: response.content || ''
//       };
//     } catch (error) {
//       console.error("Error performing web search:", error)

//       // If the error is about API configuration, show a helpful message
//       if (error instanceof Error && error.message.includes('Google Search API not configured')) {
//         throw new Error("Google Search API is not configured. Please contact administrator.");
//       }

//       throw new Error("Failed to perform web search")
//     }
//   }
// }

// export const webSearchService = new WebSearchServiceImpl()



"use client"

import { apiClient } from "./api"

export interface SearchResult {
  title: string
  url: string
  snippet: string
  displayLink?: string
}

class WebSearchServiceImpl {
  async searchStream(
    query: string,
    chatId: string | undefined,
    model: string | undefined,
    provider: string | undefined,
    onData: (content: string) => void,
    onComplete: (data: any) => void,
    onError: (error: Error) => void,
    sources?: { scopus: boolean; pubmed: boolean; gpt4oMini: boolean }
  ) {
    try {
      await apiClient.webSearchStream(
        { query, chatId, model, provider },
        (chunk: any) => {
          if (chunk.type === 'content' || chunk.type === 'start') {
            onData(chunk.content);
          } else if (chunk.type === 'done') {
            onComplete(chunk);
          } else if (chunk.type === 'error') {
            onError(new Error(chunk.error));
          }
        },
        onComplete,
        onError
      );
    } catch (error) {
      console.error("Error performing web search:", error);
      onError(new Error("Failed to perform web search"));
    }
  }
}

export const webSearchService = new WebSearchServiceImpl()
