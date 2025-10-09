// file: services/ai-service.js

const OpenAI = require('openai');
const { toFile } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Make sure to install this package: npm install @google/generative-ai
const fs = require('fs');
const prisma = require('../config/database');
const { GoogleGenAI, Modality } = require("@google/genai");
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

class AIService {
    /**
     * Provider ke naam ke hisab se sahi configured AI client return karta hai.
     * @param {string} provider - Provider ka naam (e.g., "OpenAI", "Gemini", "OpenRouter")
     * @returns {OpenAI} - OpenAI client ka instance
     */
    getClient(provider) {
        if (provider === "Gemini") {
            return new OpenAI({
                apiKey: process.env.GEMINI_API_KEY,
                baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
            });
        }

        if (provider === "OpenRouter") {
            return new OpenAI({
                apiKey: process.env.OPENROUTER_API_KEY,
                baseURL: "https://openrouter.ai/api/v1",
            });
        }

        // Default provider OpenAI hai
        return new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    /**
     * AI se response generate karta hai aur client ko stream karta hai.
     * @param {object} options - Options ka object
     * @param {string} options.provider - Istemaal hone wala provider
     * @param {string} options.model - Istemaal hone wala model
     * @param {Array<object>} options.messages - AI ko bhejne ke liye messages ka array
     * @param {import('express').Response} options.res - Express response object jis par stream likha jayega
     * @returns {Promise<string>} - Poora generate kiya hua content
     */




    async generateStream({ provider, model, messages, res, signal, streamId, files }) {
        let fullResponseContent = '';
        try {
            const client = this.getClient(provider);

            // Check if the user is asking for a chart
            const lastUserMessage = messages[messages.length - 1].content.toLowerCase();
            const chartKeywords = ['chart', 'graph', 'plot', 'diagram', 'visualize'];
            const isChartRequest = chartKeywords.some(keyword => lastUserMessage.includes(keyword));

            if (isChartRequest) {
                // Modify the system prompt to request JSON for charts
                const systemMessage = {
                    role: 'system',
                    content: `You are an expert AI assistant. When asked to create a chart, you must respond with a JSON object that can be used with the recharts library. The JSON object should have the following structure:
{
  "type": "bar", // or "line", "pie", "area", etc.
  "data": [ // array of data objects
    { "name": "Jan", "value": 4000 },
    { "name": "Feb", "value": 3000 }
  ],
  "config": { // chart configuration
    "title": "Chart Title",
    "dataKey": "value",
    "xAxisKey": "name",
    "xAxisLabel": "X-Axis Label",
    "yAxisLabel": "Y-Axis Label",
    "fill": "#8884d8"
  }
}
Do not include any other text or explanations in your response. Just the JSON object.`
                };
                messages.unshift(systemMessage);
            }

            if (files && files.length > 0) {
                const imageFile = files.find(f => f.mimeType && f.mimeType.startsWith('image/'));
                if (imageFile) {
                    const imagePath = path.join(__dirname, '../../', imageFile.path);
                    const imageData = fs.readFileSync(imagePath);
                    const base64Image = imageData.toString('base64');

                    const lastMessage = messages[messages.length - 1];
                    lastMessage.content = [
                        { type: 'text', text: lastMessage.content },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:${imageFile.mimeType};base64,${base64Image}`,
                            },
                        },
                    ];
                }
            }


            const payload = {
                model: model,
                messages: messages,
                stream: true,
            };


            // if (model.includes('gpt-5')) {

            //     console.log(`Using special parameter 'max_completion_tokens' for model: ${model}`);
            //     payload.max_completion_tokens = 8192;

            // } else {

            //     console.log(`Using standard parameter 'max_tokens' for model: ${model}`);
            //     payload.max_tokens = 8192;
            // }
            const stream = await client.chat.completions.create(payload, { signal });

            // Stream se data parhein aur client ko bhejein
            for await (const chunk of stream) {

                const contentChunk = chunk.choices[0]?.delta?.content || '';
                if (contentChunk) {
                    fullResponseContent += contentChunk;
                    // Client ko data chunk bhejein
                    res.write(`data: ${JSON.stringify({ content: contentChunk })}\n\n`);
                }
            }

            return fullResponseContent;
        } catch (apiError) {
            if (apiError && typeof apiError === 'object' && 'name' in apiError && apiError.name === 'AbortError') {
                console.warn(`AI stream aborted by client for provider: ${provider}.`);
                // Agar request abort ho gayi hai, toh koi error message client ko na bhejein
                // aur jo content receive hua hai, wahi return karein
                return fullResponseContent;
            }
            console.error(`Error from ${provider} API:`, apiError);
            res.write(`data: ${JSON.stringify({ error: `AI service (${provider}) is temporarily unavailable or stream was interrupted.` })}\n\n`);
            throw apiError;
        }
    }

    async generateImageFromImage(imagePath, prompt, provider) {
        try {
            if (provider === "Gemini") {
                const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

                const imageData = fs.readFileSync(imagePath);
                const base64Image = imageData.toString("base64");

                const requestPrompt = [
                    { text: prompt },
                    {
                        inlineData: {
                            mimeType: "image/png",
                            data: base64Image,
                        },
                    },
                ];

                const response = await ai.models.generateContent({
                    model: "gemini-2.5-flash-image-preview",
                    contents: requestPrompt,
                });

                for (const part of response.candidates[0].content.parts) {
                    if (part.inlineData && part.inlineData.data) {
                        return part.inlineData.data;
                    }
                }

                throw new Error("No image returned by Gemini");

            } else {
                const openai = new OpenAI({
                    apiKey: process.env.OPENAI_API_KEY,
                });

                const imageFile = await toFile(fs.createReadStream(imagePath), null, {
                    type: "image/png",
                });

                const response = await openai.images.edit({
                    image: imageFile,
                    prompt: prompt,
                    model: 'gpt-image-1',
                    n: 1,
                    size: '1024x1024',
                    quality: 'auto',
                });

                const image_base64 = response.data[0].b64_json;
                return image_base64;

            }
        } catch (error) {
            console.error("Error:", error.message);
            throw error;
        }
    }

    // Helper: Upload file to OpenAI
    async uploadFileToContainer(filepath, containerId) {
        const form = new FormData();
        form.append('file', fs.createReadStream(filepath));

        const response = await axios.post(
            `https://api.openai.com/v1/containers/${containerId}/files`,
            form,
            {
                headers: {
                    ...form.getHeaders(), // include multipart/form-data headers
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            }
        );

        return response.data; // contains file ID
    }


    async generateChartWithCodeInterpreter(messages, fileId) {
        const client = this.getClient("OpenAI");

        // Combine messages into a single string prompt for the 'input' field
        const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\\n\\n');
        let instructions = `
You are a data visualization expert. Based on the conversation history, when asked to create a chart or graph,
write and run Python code to generate the visualization.
You must save the output as an image file and provide a reference to it.
You are a professional developer; I will give you a scenario, you understand that and create a chart accordingly. Whenever a chart or graph is discussed, you write and run code using the python tool to answer the question.
`;

        let containerId = null;
        let tempContainer = null;

        if (fileId) {
            const fileRecord = await prisma.file.findUnique({ where: { id: fileId } });
            if (!fileRecord || !fs.existsSync(fileRecord.path)) {
                throw new Error("File not found or path is invalid for chart generation.");
            }

            tempContainer = await client.containers.create({
                name: `chart-gen-container-${Date.now()}`,
            });
            containerId = tempContainer.id;

            await this.uploadFileToContainer(fileRecord.path, containerId);
            console.log(`File ${fileRecord.originalName} uploaded to container ${containerId} for chart generation.`);

            // Update instructions to inform the AI about the uploaded file
            instructions += `\n\nA file named '${fileRecord.originalName}' has been uploaded and is available in your environment. Please use this file to generate the requested chart.`;
        }

        const resp = await client.responses.create({
            model: "gpt-4.1",
            tools: [
                {
                    type: "code_interpreter",
                    container: containerId ? containerId : { type: "auto" },
                },
            ],
            instructions,
            input: prompt,
        });

        let pythonCode = null;
        let imageUrl = null;


        // Find the code and the file citation from the response
        for (const output of resp.output) {
            if (output.type === 'code_interpreter_call') {
                pythonCode = output.code;

            }
            if (output.type === 'message' && output.content) {
                for (const contentItem of output.content) {
                    if (contentItem.annotations) {
                        for (const annotation of contentItem.annotations) {
                            if (annotation.type === 'container_file_citation') {
                                const { file_id, container_id } = annotation;
                                if (file_id && container_id) {
                                    console.log(`Found file citation: container_id=${container_id}, file_id=${file_id}`);

                                    // Download the image
                                    const downloadUrl = `https://api.openai.com/v1/containers/${container_id}/files/${file_id}/content`;
                                    const imageResponse = await axios.get(downloadUrl, {
                                        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                                        responseType: 'arraybuffer'
                                    });

                                    // Save the image to local storage
                                    const uploadsDir = path.join(__dirname, '../../uploads/images');
                                    await fs.promises.mkdir(uploadsDir, { recursive: true });

                                    const timestamp = Date.now();
                                    const filename = `chart-${timestamp}.png`;
                                    const filepath = path.join(uploadsDir, filename);

                                    await fs.promises.writeFile(filepath, imageResponse.data);

                                    // Construct the accessible URL
                                    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
                                    imageUrl = `${baseUrl}/uploads/images/${filename}`;
                                    console.log(`Image saved successfully at: ${imageUrl}`);
                                }
                            }
                        }
                    }
                }
            }
        }

        return { imageUrl, pythonCode, response: resp.output };
    }
}


// Service ka ek hi instance banayein aur export karein
module.exports = new AIService();
