const { google } = require('googleapis');
const OpenAI = require('openai');
const { OAuth2Client } = require('google-auth-library');
const prisma = require('../config/database');

/**
 * Google MCP Service - Integrates Google Calendar and Drive via OpenAI's MCP
 * This service uses OpenAI's Model Context Protocol to interact with Google services
 */
class GoogleMCPService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        this.oauth2Client = new OAuth2Client(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
    }

    _getGoogleAPIClient(tokens) {
        const auth = new OAuth2Client({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        });
        
        // Ensure tokens are in the correct format for Google OAuth2Client
        const credentials = {
            access_token: tokens.accessToken || tokens.access_token,
            refresh_token: tokens.refreshToken || tokens.refresh_token,
            token_type: tokens.tokenType || tokens.token_type || 'Bearer',
            expiry_date: tokens.expiresAt || tokens.expiry_date,
            scope: tokens.scope
        };
        
        console.log('Setting Google Services credentials:', { 
            hasAccessToken: !!credentials.access_token,
            hasRefreshToken: !!credentials.refresh_token,
            expiryDate: credentials.expiry_date ? new Date(credentials.expiry_date) : 'none',
            scope: credentials.scope
        });
        
        if (!credentials.access_token) {
            throw new Error('Google Services credentials not properly set. Missing access token.');
        }
        
        auth.setCredentials(credentials);
        return {
            calendar: google.calendar({ version: 'v3', auth }),
            drive: google.drive({ version: 'v3', auth }),
        };
    }

    async listCalendarEvents(apiClient, chatId) {
        try {
            const calendar = apiClient.calendar;
            const now = new Date();
            const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

            const res = await calendar.events.list({
                calendarId: 'primary',
                timeMin: now.toISOString(),
                timeMax: sevenDaysFromNow.toISOString(),
                maxResults: 10,
                singleEvents: true,
                orderBy: 'startTime',
            });

            const events = res.data.items;
            if (!events || events.length === 0) {
                return 'Agle 7 dino mein aapke calendar par koi events nahi hain.';
            }


            const eventDetails = events.map(event => ({
                summary: event.summary,
                start: event.start.dateTime || event.start.date,
                id: event.id,
            }));

            console.log("Fetched calendar events with IDs:", eventDetails);

            if (chatId) {
                try {
                    await prisma.chat.update({
                        where: { id: chatId },
                        data: { googleCalendarContext: eventDetails },
                    });
                    console.log(`Saved calendar context to chat ${chatId}`);
                } catch (dbError) {
                    console.error("Failed to save calendar context to DB:", dbError);
                }
            }

            const eventDetailsJSON = JSON.stringify(eventDetails);

            const instructionForAI = "\n\nCRITICAL NOTE TO AI: This is the list of events. To update or delete a specific event, you MUST use the 'id' field from this list in your next tool call. Do not guess the ID.";

            return eventDetailsJSON + instructionForAI;



        } catch (error) {
            console.error("Calendar events list karne mein error: ", error);
            return "Calendar events hasil karne mein error aayi.";
        }
    }
    async updateCalendarEvent(apiClient, { eventId, summary, description, startTime, endTime }, timeZone, chatId) {
        try {
            if (!eventId && chatId) {
                const chat = await prisma.chat.findUnique({ where: { id: chatId } });
                if (chat && chat.googleCalendarContext && chat.googleCalendarContext.length > 0) {
                    eventId = chat.googleCalendarContext[0].id;
                    console.log(`Found eventId from DB context: ${eventId}`);
                }
            }
            if (!eventId) {
                return "Event ID nahi di gayi. Pehle events list karein aur phir ID batayein.";
            }
            const calendar = apiClient.calendar;

            // Pehle event ki mojooda details hasil karein
            const existingEvent = await calendar.events.get({
                calendarId: 'primary',
                eventId: eventId,
            });

            // Sirf woh cheezein update karein jo user ne di hain
            const eventPatch = {
                summary: summary || existingEvent.data.summary,
                description: description || existingEvent.data.description,
                start: {
                    dateTime: startTime || existingEvent.data.start.dateTime,
                    timeZone: timeZone
                },
                end: {
                    dateTime: endTime || existingEvent.data.end.dateTime,
                    timeZone: timeZone
                },
            };

            const res = await calendar.events.patch({
                calendarId: 'primary',
                eventId: eventId,
                resource: eventPatch,
            });

            return `Event '${res.data.summary}' kamyabi se update ho gaya hai.`;

        } catch (error) {
            console.error("Calendar event update karne mein error: ", error.message);
            return "Event update karne mein error aayi. Shayad Event ID ghalat hai.";
        }
    }
    async deleteCalendarEvent(apiClient, { eventId }, chatId) {
        try {
            if (!eventId && chatId) {
                const chat = await prisma.chat.findUnique({ where: { id: chatId } });
                if (chat && chat.googleCalendarContext && chat.googleCalendarContext.length > 0) {
                    eventId = chat.googleCalendarContext[0].id;
                    console.log(`Found eventId from DB context for deletion: ${eventId}`);
                }
            }
            if (!eventId) {
                return "Event ID nahi di gayi. Pehle events list karein aur phir ID batayein.";
            }
            const calendar = apiClient.calendar;
            await calendar.events.delete({
                calendarId: 'primary',
                eventId: eventId,
            });
            return ` Event ID ${eventId} wala event kamyabi se delete ho gaya hai.`;
        } catch (error) {
            console.error("Calendar event delete karne mein error: ", error.message);
            return "Event delete karne mein error aayi.";
        }
    }

    // b. Google Calendar: Naya event banana
    async createCalendarEvent(apiClient, { summary, description, startTime, endTime }, timeZone) {
        try {
            const calendar = apiClient.calendar;
            const event = {
                summary,
                description,
                start: { dateTime: startTime, timeZone: timeZone },
                end: { dateTime: endTime, timeZone: timeZone },
            };

            const res = await calendar.events.insert({ calendarId: 'primary', resource: event });
            return `Event kamyabi se ban gaya hai. Event ka naam hai: '${res.data.summary}'`;
        } catch (error) {
            console.error("Calendar event banane mein error: ", error);
            return "Event banane mein error aayi. Time format ISO 8601 hona chahiye (maslan, 2025-12-31T14:00:00).";
        }
    }

    // c. Google Drive: Files list karna
    async listDriveFiles(apiClient, { query }) {
        try {
            const drive = apiClient.drive;

            const conversionPrompt = `User ki is natural language query ko Google Drive API search query mein badlo. Sirf query string return karo, koi extra text nahi.

User Query: "${query}"

Examples:
- "my presentations" -> "mimeType='application/vnd.google-apps.presentation'"
- "PDFs shared by hamza" -> "mimeType='application/pdf' and 'hamza@example.com' in writers"
- "documents I edited last week" -> "modifiedTime > '${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}' and mimeType='application/vnd.google-apps.document'"
- "images of cats" -> "name contains 'cat' and (mimeType='image/jpeg' or mimeType='image/png')"

Query:`;

            const queryConversionResponse = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are a Google Drive API expert. Convert natural language to a valid Drive query string. Respond only with the query string." },
                    { role: "user", content: conversionPrompt }
                ],
                temperature: 0.1,
            });

            let driveQuery = queryConversionResponse.choices[0].message.content.trim();
            driveQuery = driveQuery.replace(/^"|"$/g, ''); // Remove leading/trailing quotes
            console.log(`Converted natural language "${query}" to Drive query: "${driveQuery}"`);

            const res = await drive.files.list({
                q: driveQuery,
                pageSize: 10,
                fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink)',
            });
            const files = res.data.files;
            if (!files || files.length === 0) {
                return "Aapke Google Drive mein is search ke mutabiq koi files nahi mili.";
            }
            return JSON.stringify(files);
        } catch (error) {
            console.error("Drive files list karne mein error: ", error);
            return "Drive se files hasil karne mein error aayi.";
        }
    }

    async createGoogleDoc(apiClient, { title, content }) {
        try {
            const drive = apiClient.drive;
            const fileMetadata = {
                name: title,
                mimeType: 'application/vnd.google-apps.document',
            };
            const media = {
                mimeType: 'text/plain',
                body: content,
            };
            const res = await drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id, webViewLink',
            });
            return `Google Doc "${title}" kamyabi se ban gaya hai. Link: ${res.data.webViewLink}`;
        } catch (error) {
            console.error("Google Doc banane mein error: ", error);
            return "Google Doc banane mein error aayi.";
        }
    }

    async summarizeFile(apiClient, { fileId }) {
        try {
            const drive = apiClient.drive;
            // Pehle file ka content hasil karein
            const res = await drive.files.get({
                fileId: fileId,
                alt: 'media',
            });

            const fileContent = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

            if (fileContent.length < 50) {
                return "File ka content summary ke liye bahut chota hai.";
            }

            // Ab AI se summary banwayein
            const summaryResponse = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are an expert summarizer. Create a concise, easy-to-read summary of the following document content. Respond only with the summary." },
                    { role: "user", content: `Please summarize this:\n\n${fileContent.substring(0, 15000)}` } // Limit context size
                ],
                temperature: 0.3,
            });

            return `File ki summary:\n\n${summaryResponse.choices[0].message.content}`;
        } catch (error) {
            console.error("File summarize karne mein error:", error);
            return "File ko summarize karne mein error aayi. Ho sakta hai yeh file type support na karti ho.";
        }
    }

    async getFileDetails(apiClient, { fileId }) {
        try {
            const drive = apiClient.drive;
            const res = await drive.files.get({
                fileId: fileId,
                fields: 'id, name, mimeType, createdTime, modifiedTime, owners, webViewLink, size, capabilities',
            });
            return JSON.stringify(res.data);
        } catch (error) {
            console.error("File details hasil karne mein error:", error);
            return "File ki details hasil karne mein error aayi.";
        }
    }

    // d. Google Drive: File ka content hasil karna (Text files ke liye)
    async getFileContent(apiClient, { fileId }) {
        try {
            const drive = apiClient.drive;
            const res = await drive.files.get({
                fileId: fileId,
                alt: 'media',
            });
            // Solo funciona correctamente con archivos basados en texto.
            return typeof res.data === 'string' ? res.data.substring(0, 4000) : "El contenido del archivo no está en formato de texto.";
        } catch (error) {
            console.error("File content hasil karne mein error:", error);
            return "File ka content hasil karne mein error aayi.";
        }
    }
    async processRequest(chatHistory, tokens, timeZone, chatId) {
        console.log('timeZone', timeZone);

        // 1. Google API clients ko initialize karein
        const googleAPIClient = this._getGoogleAPIClient(tokens);
        const today = new Date().toLocaleString('en-US', { timeZone: timeZone });
        const systemMessage = `You are a helpful assistant. The user's current date and time is ${today} in their local timezone (${timeZone}). When a user asks to create an event with relative times like 'tomorrow at 5pm', you must calculate the exact ISO 8601 timestamp based on this date and timezone. CRITICAL: When the user asks to update or delete an event after you have listed events, you MUST use the 'id' of the event from the list. Do not make up an ID. Look at the previous tool call result for the correct event 'id'. IMPORTANT: You must detect the user's language from their prompt and ALWAYS respond in that same language.`;
        // 2. OpenAI ko batayein ke aapke paas konse tools/functions hain
        const tools = [
            {
                type: "function",
                function: {
                    name: "list_calendar_events",
                    description: "User ke Google Calendar se anay walay events ki list hasil karo (default agle 7 din).",
                },
            },
            {
                type: "function",
                function: {
                    name: "update_calendar_event",
                    description: "Pehle se mojood calendar event ko uski Event ID ke zariye update karo. Agar user kisi event ka zikr kare jo abhi list kiya gaya hai (maslan, 'isko update karo'), to pichle list_calendar_events call se ID istemal karo. Agar Event ID wazeh na ho, to pehle list_calendar_events function ka istemal karke user ko events dikhao aur us se sahi Event ID poocho, phir is function ko call karo.",
                    parameters: {
                        type: "object",
                        properties: {
                            eventId: { type: "string", description: "Jis event ko update karna hai uski unique ID." },
                            summary: { type: "string", description: "Event ka naya title (optional)." },
                            description: { type: "string", description: "Event ki nayi tafseelat (optional)." },
                            startTime: { type: "string", description: "Event ka naya shuru hone ka waqt (optional)." },
                            endTime: { type: "string", description: "Event ka naya khatam hone ka waqt (optional)." },
                        },
                        required: ["eventId"], // Sirf eventId laazmi hai
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "delete_calendar_event",
                    description: "Ek event ko uski Event ID ke zariye delete karo. Agar user kisi event ka zikr kare jo abhi list kiya gaya hai (maslan, 'isay delete kardo'), to pichle list_calendar_events call se ID istemal karo. Agar user ne Event ID nahi di, to pehle list_calendar_events function ka istemal karke user ko events dikhao aur us se sahi Event ID poocho, phir is function ko call karo.",
                    parameters: {
                        type: "object",
                        properties: {
                            eventId: { type: "string", description: "Jis event ko delete karna hai uski unique ID." },
                        },
                        required: ["eventId"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "create_calendar_event",
                    description: "User ke Google Calendar mein ek naya event ya meeting banao.",
                    parameters: {
                        type: "object",
                        properties: {
                            summary: { type: "string", description: "Event ka title." },
                            description: { type: "string", description: "Event ki tafseelat." },
                            startTime: { type: "string", description: "Event shuru hone ka waqt ISO 8601 format mein." },
                            endTime: { type: "string", description: "Event khatam hone ka waqt ISO 8601 format mein." },
                        },
                        required: ["summary", "startTime", "endTime"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "list_drive_files",
                    description: "User ke Google Drive se files ya folders ko unki natural language query ke zariye search karo. Maslan, 'find my reports from last week'.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "User ki natural language search query, maslan 'marketing presentations' ya 'PDFs shared by hamza'." },
                        },
                        required: ["query"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "create_google_doc",
                    description: "Google Drive mein ek naya Google Doc banao.",
                    parameters: {
                        type: "object",
                        properties: {
                            title: { type: "string", description: "Document ka title." },
                            content: { type: "string", description: "Document ka shuruaati content." },
                        },
                        required: ["title", "content"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "summarize_file",
                    description: "Genera un resumen del contenido de un archivo a partir de su ID. Funciona mejor con archivos de texto.",
                    parameters: {
                        type: "object",
                        properties: {
                            fileId: { type: "string", description: "Jis file ko summarize karna hai uski ID." },
                        },
                        required: ["fileId"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "get_file_details",
                    description: "Ek specific file ID de kar uski tafseelat (metadata) hasil karo.",
                    parameters: {
                        type: "object",
                        properties: {
                            fileId: { type: "string", description: "Jis file ki details chahiye uski ID." },
                        },
                        required: ["fileId"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "get_file_content",
                    description: "Lee el contenido en bruto de un archivo a partir de su ID (recomendado para archivos de texto).",
                    parameters: {
                        type: "object",
                        properties: {
                            fileId: { type: "string", description: "Jis file ko parhna hai uski ID." },
                        },
                        required: ["fileId"],
                    },
                },
            },
        ];

        // const messages = [
        //     { role: "system", content: systemMessage },
        //     { role: "user", content: userPrompt }
        // ];
        const messages = [
            { role: "system", content: systemMessage },
            ...chatHistory.map(({ role, content }) => ({
                role: role === 'USER' ? 'user' : 'assistant',
                content
            }))
        ];

        try {
            // 3. Pehli AI Call: Faisla karne ke liye ke konsa tool istemal karna hai
            const initialResponse = await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                tools: tools,
                tool_choice: "auto",
            });

            const responseMessage = initialResponse.choices[0].message;
            const toolCalls = responseMessage.tool_calls;

            // 4. Agar AI ne tool istemal karne ka faisla kiya
            if (toolCalls) {
                messages.push(responseMessage); // Conversation history mein AI ka jawab shamil karein

                for (const toolCall of toolCalls) {
                    console.log('toolCall', toolCall);

                    const functionName = toolCall.function.name;
                    const functionArgs = JSON.parse(toolCall.function.arguments);
                    let functionResult;

                    // 5. Sahi function ko call karein
                    switch (functionName) {
                        case "list_calendar_events":
                            functionResult = await this.listCalendarEvents(googleAPIClient, chatId);
                            break;
                        case "delete_calendar_event":
                            functionResult = await this.deleteCalendarEvent(googleAPIClient, functionArgs, chatId);
                            break;
                        case "update_calendar_event":
                            functionResult = await this.updateCalendarEvent(googleAPIClient, functionArgs, timeZone, chatId);
                            break;
                        case "create_calendar_event":
                            functionResult = await this.createCalendarEvent(googleAPIClient, functionArgs, timeZone);
                            break;
                        case "list_drive_files":
                            functionResult = await this.listDriveFiles(googleAPIClient, functionArgs);
                            break;
                        case "create_google_doc":
                            functionResult = await this.createGoogleDoc(googleAPIClient, functionArgs);
                            break;
                        case "summarize_file":
                            functionResult = await this.summarizeFile(googleAPIClient, functionArgs);
                            break;
                        case "get_file_details":
                            functionResult = await this.getFileDetails(googleAPIClient, functionArgs);
                            break;
                        case "get_file_content":
                            functionResult = await this.getFileContent(googleAPIClient, functionArgs);
                            break;
                        default:
                            functionResult = "Unknown function called.";
                    }

                    // 6. Tool ka result conversation history mein shamil karein
                    messages.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: functionName,
                        content: functionResult,
                    });
                }

                // 7. Doosri AI Call: Final, insani jawab banane ke liye
                const finalResponse = await this.openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: messages,
                });

                return { success: true, content: finalResponse.choices[0].message.content };

            } else {
                // Agar koi tool istemal nahi hua, to seedha AI ka jawab bhej dein
                return { success: true, content: responseMessage.content };
            }
        } catch (error) {
            console.error('OpenAI Function Calling error:', error);
            if (error.message?.includes('invalid_grant')) {
                throw new Error('Aapka Google connection expire ho gaya hai. Dobara connect karein.');
            }
            throw error;
        }
    }


    /**
     * Get system prompt based on service
     */
    getSystemPrompt(service) {
        const basePrompt = `You are a helpful AI assistant with access to Google services via MCP connectors.`;

        if (service === 'calendar') {
            return `${basePrompt}

You have access to Google Calendar and can:
- List upcoming events
- Create new calendar events
- Update existing events
- Delete events
- Search for specific events
- Get event details
- Manage event reminders and notifications

When the user asks about their schedule, meetings, appointments, or calendar-related tasks, use the Google Calendar connector to help them.

Format responses clearly with:
- Event titles, dates, and times
- Attendees and location if applicable
- Event descriptions
- Links to events when available

Be proactive and helpful in managing their calendar.`;
        }

        if (service === 'drive') {
            return `${basePrompt}

You have access to Google Drive and can:
- List files and folders
- Search for documents, spreadsheets, presentations
- Get file details and metadata
- Share files with others
- Download file contents
- Create new documents
- Upload files
- Organize files into folders

When the user asks about their files, documents, or Drive-related tasks, use the Google Drive connector to help them.

Format responses clearly with:
- File names and types
- Last modified dates
- File sizes
- Sharing permissions
- Links to open files

Be organized and helpful in managing their files.`;
        }

        // Both services
        return `${basePrompt}

You have access to both Google Calendar and Google Drive and can:

**Google Calendar:**
- List, create, update, and delete events
- Search for meetings and appointments
- Manage event details and reminders

**Google Drive:**
- List, search, and organize files
- Get file details and contents
- Share and manage file permissions
- Create and upload documents

Understand the user's intent and use the appropriate service. Format responses clearly and be helpful.`;
    }

    /**
     * Analyze user intent to determine which service to use
     */
    async analyzeIntent(userPrompt) {
        const calendarKeywords = ['calendar', 'event', 'meeting', 'appointment', 'schedule', 'remind', 'tomorrow', 'today', 'next week'];
        const driveKeywords = ['drive', 'file', 'document', 'folder', 'upload', 'download', 'share', 'spreadsheet', 'doc'];

        const lowerPrompt = userPrompt.toLowerCase();

        const hasCalendarIntent = calendarKeywords.some(keyword => lowerPrompt.includes(keyword));
        const hasDriveIntent = driveKeywords.some(keyword => lowerPrompt.includes(keyword));

        if (hasCalendarIntent && !hasDriveIntent) return 'calendar';
        if (hasDriveIntent && !hasCalendarIntent) return 'drive';

        // If both or neither, return 'both' to let AI decide
        return 'both';
    }
}

module.exports = new GoogleMCPService();
