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
                return 'No tiene eventos en su calendario para los próximos 7 días.';
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
            console.error("Error al listar los eventos del calendario: ", error);
            return "Ocurrió un error al obtener los eventos del calendario.";
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
                return "No se proporcionó el Event ID. Primero liste los eventos y luego indique el ID.";
            }
            const calendar = apiClient.calendar;

            // Primero obtener los detalles existentes del evento
            const existingEvent = await calendar.events.get({
                calendarId: 'primary',
                eventId: eventId,
            });

            // Actualizar únicamente los campos proporcionados por el usuario
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

            return `El evento '${res.data.summary}' se actualizó correctamente.`;

        } catch (error) {
            console.error("Error al actualizar el evento del calendario: ", error.message);
            return "Ocurrió un error al actualizar el evento. Es posible que el Event ID sea incorrecto.";
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
                return "No se proporcionó el Event ID. Primero liste los eventos y luego indique el ID.";
            }
            const calendar = apiClient.calendar;
            await calendar.events.delete({
                calendarId: 'primary',
                eventId: eventId,
            });
            return `El evento con Event ID ${eventId} se eliminó correctamente.`;
        } catch (error) {
            console.error("Error al eliminar el evento del calendario: ", error.message);
            return "Ocurrió un error al eliminar el evento.";
        }
    }

    // b. Google Calendar: crear un nuevo evento
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
            return `El evento se creó correctamente. Nombre del evento: '${res.data.summary}'`;
        } catch (error) {
            console.error("Error al crear el evento del calendario: ", error);
            return "Ocurrió un error al crear el evento. El formato de hora debe ser ISO 8601 (por ejemplo, 2025-12-31T14:00:00).";
        }
    }

    // c. Google Drive: listar archivos
    async listDriveFiles(apiClient, { query }) {
        try {
            const drive = apiClient.drive;

            const conversionPrompt = `Convierta la siguiente consulta del usuario en lenguaje natural en una query de búsqueda de la API de Google Drive. Devuelva únicamente la cadena de la query, sin texto adicional.

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
                return "No se encontraron archivos en su Google Drive que coincidan con esta búsqueda.";
            }
            return JSON.stringify(files);
        } catch (error) {
            console.error("Error al listar los archivos de Drive: ", error);
            return "Ocurrió un error al obtener los archivos desde Drive.";
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
            return `El Google Doc "${title}" se creó correctamente. Link: ${res.data.webViewLink}`;
        } catch (error) {
            console.error("Error al crear el Google Doc: ", error);
            return "Ocurrió un error al crear el Google Doc.";
        }
    }

    async summarizeFile(apiClient, { fileId }) {
        try {
            const drive = apiClient.drive;
            // Primero obtener el contenido del archivo
            const res = await drive.files.get({
                fileId: fileId,
                alt: 'media',
            });

            const fileContent = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

            if (fileContent.length < 50) {
                return "El contenido del archivo es demasiado breve para generar un resumen.";
            }

            // Pedir a la IA que genere el resumen
            const summaryResponse = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are an expert summarizer. Create a concise, easy-to-read summary of the following document content. Respond only with the summary." },
                    { role: "user", content: `Please summarize this:\n\n${fileContent.substring(0, 15000)}` } // Limit context size
                ],
                temperature: 0.3,
            });

            return `Resumen del archivo:\n\n${summaryResponse.choices[0].message.content}`;
        } catch (error) {
            console.error("Error al resumir el archivo:", error);
            return "Ocurrió un error al resumir el archivo. Es posible que el tipo de archivo no esté soportado.";
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
            console.error("Error al obtener los detalles del archivo:", error);
            return "Ocurrió un error al obtener los detalles del archivo.";
        }
    }

    // d. Google Drive: obtener el contenido del archivo (para archivos de texto)
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
            console.error("Error al obtener el contenido del archivo:", error);
            return "Ocurrió un error al obtener el contenido del archivo.";
        }
    }
    async processRequest(chatHistory, tokens, timeZone, chatId) {
        console.log('timeZone', timeZone);

        // 1. Inicializar los clientes de las APIs de Google
        const googleAPIClient = this._getGoogleAPIClient(tokens);
        const today = new Date().toLocaleString('en-US', { timeZone: timeZone });
        const systemMessage = `You are a helpful assistant. The user's current date and time is ${today} in their local timezone (${timeZone}). When a user asks to create an event with relative times like 'tomorrow at 5pm', you must calculate the exact ISO 8601 timestamp based on this date and timezone. CRITICAL: When the user asks to update or delete an event after you have listed events, you MUST use the 'id' of the event from the list. Do not make up an ID. Look at the previous tool call result for the correct event 'id'. IMPORTANT: You must detect the user's language from their prompt and ALWAYS respond in that same language.`;
        // 2. Indicar a OpenAI qué herramientas/funciones están disponibles
        const tools = [
            {
                type: "function",
                function: {
                    name: "list_calendar_events",
                    description: "Obtiene la lista de los próximos eventos del Google Calendar del usuario (por defecto los próximos 7 días).",
                },
            },
            {
                type: "function",
                function: {
                    name: "update_calendar_event",
                    description: "Actualiza un evento existente del calendario mediante su Event ID. Si el usuario hace referencia a un evento recién listado (por ejemplo, 'actualízalo'), reutilice el ID de la llamada previa a list_calendar_events. Si el Event ID no está claro, primero invoque list_calendar_events para mostrar los eventos al usuario, solicítele el Event ID correcto y luego llame a esta función.",
                    parameters: {
                        type: "object",
                        properties: {
                            eventId: { type: "string", description: "ID único del evento que se desea actualizar." },
                            summary: { type: "string", description: "Nuevo título del evento (opcional)." },
                            description: { type: "string", description: "Nueva descripción del evento (opcional)." },
                            startTime: { type: "string", description: "Nueva hora de inicio del evento (opcional)." },
                            endTime: { type: "string", description: "Nueva hora de fin del evento (opcional)." },
                        },
                        required: ["eventId"], // Únicamente eventId es obligatorio
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "delete_calendar_event",
                    description: "Elimina un evento mediante su Event ID. Si el usuario hace referencia a un evento recién listado (por ejemplo, 'elimínalo'), reutilice el ID de la llamada previa a list_calendar_events. Si el usuario no indicó el Event ID, primero invoque list_calendar_events para mostrar los eventos al usuario, solicítele el Event ID correcto y luego llame a esta función.",
                    parameters: {
                        type: "object",
                        properties: {
                            eventId: { type: "string", description: "ID único del evento que se desea eliminar." },
                        },
                        required: ["eventId"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "create_calendar_event",
                    description: "Crea un nuevo evento o reunión en el Google Calendar del usuario.",
                    parameters: {
                        type: "object",
                        properties: {
                            summary: { type: "string", description: "Título del evento." },
                            description: { type: "string", description: "Descripción del evento." },
                            startTime: { type: "string", description: "Hora de inicio del evento en formato ISO 8601." },
                            endTime: { type: "string", description: "Hora de fin del evento en formato ISO 8601." },
                        },
                        required: ["summary", "startTime", "endTime"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "list_drive_files",
                    description: "Busca archivos o carpetas en el Google Drive del usuario a partir de una consulta en lenguaje natural. Por ejemplo, 'find my reports from last week'.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "Consulta en lenguaje natural del usuario, por ejemplo 'marketing presentations' o 'PDFs shared by hamza'." },
                        },
                        required: ["query"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "create_google_doc",
                    description: "Crea un nuevo Google Doc en Google Drive.",
                    parameters: {
                        type: "object",
                        properties: {
                            title: { type: "string", description: "Título del documento." },
                            content: { type: "string", description: "Contenido inicial del documento." },
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
                            fileId: { type: "string", description: "ID del archivo que se desea resumir." },
                        },
                        required: ["fileId"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "get_file_details",
                    description: "Obtiene los detalles (metadata) de un archivo a partir de su ID.",
                    parameters: {
                        type: "object",
                        properties: {
                            fileId: { type: "string", description: "ID del archivo cuyos detalles se desean obtener." },
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
                            fileId: { type: "string", description: "ID del archivo que se desea leer." },
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
            // 3. Primera llamada a la IA: decidir qué herramienta utilizar
            const initialResponse = await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                tools: tools,
                tool_choice: "auto",
            });

            const responseMessage = initialResponse.choices[0].message;
            const toolCalls = responseMessage.tool_calls;

            // 4. Si la IA decidió invocar una herramienta
            if (toolCalls) {
                messages.push(responseMessage); // Agregar la respuesta de la IA al historial de la conversación

                for (const toolCall of toolCalls) {
                    console.log('toolCall', toolCall);

                    const functionName = toolCall.function.name;
                    const functionArgs = JSON.parse(toolCall.function.arguments);
                    let functionResult;

                    // 5. Invocar la función correspondiente
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

                    // 6. Agregar el resultado de la herramienta al historial de la conversación
                    messages.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: functionName,
                        content: functionResult,
                    });
                }

                // 7. Segunda llamada a la IA: generar la respuesta final en lenguaje natural
                const finalResponse = await this.openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: messages,
                });

                return { success: true, content: finalResponse.choices[0].message.content };

            } else {
                // Si no se utilizó ninguna herramienta, devolver directamente la respuesta de la IA
                return { success: true, content: responseMessage.content };
            }
        } catch (error) {
            console.error('OpenAI Function Calling error:', error);
            if (error.message?.includes('invalid_grant')) {
                throw new Error('Su conexión con Google ha expirado. Vuelva a conectarse.');
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
