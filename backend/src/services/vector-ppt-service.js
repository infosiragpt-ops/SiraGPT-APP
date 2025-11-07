// backend/src/services/vector-ppt-service.js
// Vector-based Presentation Service - Gamma.app style
// Generates presentations with AI-analyzed content and pure vector graphics

const PptxGenJS = require('pptxgenjs');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs').promises;
const vectorShapes = require('./ppt-vector-shapes');
const { addVectorBackground, backgroundStyles } = require('./ppt-vector-backgrounds');

class VectorPPTService {
    constructor() {
        this.vectorLibrary = this.initializeVectorLibrary();
    }

    /**
     * Initialize vector graphics library with patterns and color schemes.
     */
    initializeVectorLibrary() {
        return {
            patterns: {
                technology: ['hexagon', 'circuit', 'grid', 'network'],
                business: ['arrow', 'chart', 'growth', 'target'],
                education: ['book', 'bulb', 'brain', 'pencil'],
                health: ['heart', 'pulse', 'cross', 'shield'],
                finance: ['coin', 'graph', 'trend', 'bar'],
                marketing: ['megaphone', 'funnel', 'magnet', 'rocket'],
                data: ['database', 'cloud', 'server', 'analytics']
            },
            colorSchemes: {
                professional: { primary: '1e3a8a', secondary: '3b82f6', accent: '60a5fa', background: 'f0f9ff', text: '1e293b' },
                creative: { primary: '7c3aed', secondary: 'a78bfa', accent: 'c4b5fd', background: 'faf5ff', text: '1e293b' },
                energetic: { primary: 'dc2626', secondary: 'f97316', accent: 'fbbf24', background: 'fef2f2', text: '1e293b' },
                calm: { primary: '059669', secondary: '10b981', accent: '6ee7b7', background: 'f0fdf4', text: '1e293b' },
                modern: { primary: '0f172a', secondary: '475569', accent: '94a3b8', background: 'f8fafc', text: '0f172a' }
            }
        };
    }

    /**
     * Get AI client based on the provider.
     * @param {string} provider - The AI provider (e.g., "OpenAI", "Gemini").
     * @returns {OpenAI} - An instance of the OpenAI client.
     */
    getClient(provider) {
        if (provider === "Gemini") {
            return new OpenAI({
                apiKey: process.env.GEMINI_API_KEY,
                baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
            });
        }
        return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    /**
     * Analyze presentation content to determine the visual style.
     * @param {object} content - The presentation structure.
     * @param {string} provider - The AI provider.
     * @returns {Promise<object>} - A promise that resolves to the visual analysis.
     */
    async analyzeContentForVisuals(content, provider = "OpenAI") {
        try {
            const client = this.getClient(provider);
            const analysisPrompt = `Analyze this presentation content and determine:
1. Main topic category (technology/business/education/health/finance/marketing/data)
2. Mood/tone (professional/creative/energetic/calm/modern)
3. Key concepts for each slide (for vector visualization)

Content: ${JSON.stringify(content)}

Respond with JSON only:
{
    "category": "technology",
    "mood": "professional",
    "slides": [
        { "slideIndex": 0, "concepts": ["innovation", "growth", "future"], "vectorType": "network", "emphasis": "high" }
    ]
}`;

            const response = await client.chat.completions.create({
                model: provider === "Gemini" ? "gemini-2.0-flash-exp" : "gpt-4o-mini",
                messages: [
                    { role: 'system', content: 'You are a visual design expert. Analyze content and suggest vector graphics.' },
                    { role: 'user', content: analysisPrompt }
                ]
            });

            const analysisText = response.choices[0].message.content;
            const jsonMatch = analysisText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, analysisText];
            return JSON.parse(jsonMatch[1].trim());
        } catch (error) {
            console.error('Content analysis error:', error);
            return { category: 'business', mood: 'professional', slides: [] };
        }
    }

    /**
     * Adds a vector shape to the slide using the external shapes library.
     * @param {object} slide - The slide object from PptxGenJS.
     * @param {string} shapeType - The type of shape to add.
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {number} w - The width.
     * @param {number} h - The height.
     * @param {object} colors - The color scheme.
     */
    addVectorShape(slide, shapeType, x, y, w, h, colors) {
        const shapeFunction = vectorShapes[shapeType] || vectorShapes.grid;
        shapeFunction(slide, x, y, w, h, colors);
    }

    /**
     * Generates the complete vector-based presentation.
     * @param {string} prompt - The user's prompt for the presentation.
     * @param {string} provider - The AI provider.
     * @param {string} model - The AI model to use.
     * @returns {Promise<object>} - A promise that resolves to the presentation details.
     */
    async generateVectorPresentation(prompt, provider = "OpenAI", model = "gpt-4o") {
        try {
            const client = this.getClient(provider);

            // Step 1: Generate presentation structure
            console.log('🎨 Generating presentation structure...');
            const pptStructure = await this.generatePPTStructure(client, model, prompt);

            // Step 2: Analyze content for visual design
            console.log('🎨 Analyzing content for vector design...');
            const visualAnalysis = await this.analyzeContentForVisuals(pptStructure, provider);
            const colorScheme = this.vectorLibrary.colorSchemes[visualAnalysis.mood] || this.vectorLibrary.colorSchemes.professional;

            // Step 3: Create and configure the PowerPoint presentation
            const ppt = this.createPptInstance(pptStructure.title);

            // Step 4: Create slides with vector graphics
            this.createSlides(ppt, pptStructure, visualAnalysis, colorScheme);

            // Step 5: Save the presentation and get the download URL
            const timestamp = Date.now();
            const filename = `vector-presentation-${timestamp}.pptx`;
            const { downloadUrl } = await this.savePresentation(ppt, filename);

            console.log('✅ Vector presentation generated successfully:', filename);
            return {
                filename,
                downloadUrl,
                structure: pptStructure,
                slideCount: pptStructure.slides.length,
                colorScheme: visualAnalysis.mood,
                category: visualAnalysis.category
            };
        } catch (error) {
            console.error('❌ Error generating vector presentation:', error);
            throw error;
        }
    }

    /**
     * Generates the presentation structure using an AI model.
     */
    async generatePPTStructure(client, model, prompt) {
        const structurePrompt = {
            role: 'system',
            content: `You are an expert presentation creator. Create a professional presentation structure.
Return ONLY valid JSON with this exact format:
{
  "title": "Presentation Title",
  "slides": [
    { "type": "title", "title": "Main Title", "subtitle": "Engaging subtitle" },
    { "type": "content", "title": "Slide Title", "content": ["Point 1", "Point 2", "Point 3", "Point 4"] },
    { "type": "two-column", "title": "Comparison", "leftContent": ["Left point 1", "Left point 2"], "rightContent": ["Right point 1", "Right point 2"] },
    { "type": "visual", "title": "Visual Slide", "content": ["Key point 1", "Key point 2"], "visualConcept": "growth and innovation" }
  ]
}
Types: "title", "content", "two-column", "visual". Generate 6-10 slides. Each content slide needs 4-6 detailed points.`
        };

        const response = await client.chat.completions.create({
            model,
            messages: [structurePrompt, { role: 'user', content: `Create a presentation about: ${prompt}` }]
        });

        const responseText = response.choices[0].message.content;
        const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, responseText];
        return JSON.parse(jsonMatch[1].trim());
    }

    /**
     * Creates and configures a PptxGenJS instance.
     */
    createPptInstance(title) {
        const ppt = new PptxGenJS();
        ppt.author = 'AI Vector Designer';
        ppt.subject = title;
        ppt.title = title;
        ppt.defineLayout({ name: 'CUSTOM', width: 10, height: 5.625 });
        ppt.layout = 'CUSTOM';
        return ppt;
    }

    /**
     * Creates and adds all slides to the presentation.
     */
    createSlides(ppt, pptStructure, visualAnalysis, colorScheme) {
        const backgroundStyleKeys = Object.keys(backgroundStyles);
        pptStructure.slides.forEach((slideData, index) => {
            const slide = ppt.addSlide();
            const backgroundStyle = backgroundStyleKeys[index % backgroundStyleKeys.length];
            addVectorBackground(slide, backgroundStyle, colorScheme);

            this.addSlideContent(slide, slideData, visualAnalysis, colorScheme, index);

            slide.addText(`${index + 1}`, {
                x: 9.2, y: 5.2, w: 0.5, h: 0.3,
                fontSize: 12, color: colorScheme.secondary, align: 'right'
            });
        });
    }

    /**
     * Adds content to a single slide based on its type.
     */
    addSlideContent(slide, slideData, visualAnalysis, colorScheme, index) {
        switch (slideData.type) {
            case 'title':
                this.addTitleSlideContent(slide, slideData, colorScheme);
                break;
            case 'content':
                this.addContentSlideContent(slide, slideData, visualAnalysis, colorScheme, index);
                break;
            case 'two-column':
                this.addTwoColumnSlideContent(slide, slideData, colorScheme);
                break;
            case 'visual':
                this.addVisualSlideContent(slide, slideData, visualAnalysis, colorScheme, index);
                break;
            default:
                this.addContentSlideContent(slide, slideData, visualAnalysis, colorScheme, index);
        }
    }

    /**
     * Adds content for a title slide.
     */
    addTitleSlideContent(slide, slideData, colorScheme) {
        this.addVectorShape(slide, 'swoosh', 6, 1, 3.5, 3.5, colorScheme);
        slide.addText(slideData.title, {
            x: 0.5, y: 1.8, w: 5.5, h: 1.5,
            fontSize: 48, bold: true, color: colorScheme.primary,
            align: 'left', valign: 'middle', autoFit: true
        });
        if (slideData.subtitle) {
            slide.addText(slideData.subtitle, {
                x: 0.5, y: 3.3, w: 5.5, h: 0.8,
                fontSize: 24, color: colorScheme.text,
                align: 'left', autoFit: true
            });
        }
    }

    /**
     * Adds content for a standard content slide.
     */
    addContentSlideContent(slide, slideData, visualAnalysis, colorScheme, index) {
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: 4.5, h: 0.5,
            fontSize: 36, bold: true, color: colorScheme.primary,
            align: 'left', valign: 'middle', autoFit: true
        });

        const bulletPoints = (slideData.content || []).map(point => ({
            text: point,
            options: { bullet: { color: colorScheme.secondary }, fontSize: 18, color: colorScheme.text, align: 'left' }
        }));
        slide.addText(bulletPoints, { x: 0.5, y: 1.3, w: 4.5, h: 3.5, autoFit: true, valign: 'top' });

        const patterns = this.vectorLibrary.patterns[visualAnalysis.category] || this.vectorLibrary.patterns.business;
        const selectedPattern = patterns[index % patterns.length];
        this.addVectorShape(slide, selectedPattern, 5.5, 1.2, 4, 3.8, colorScheme);
    }

    /**
     * Adds content for a two-column slide.
     */
    addTwoColumnSlideContent(slide, slideData, colorScheme) {
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: 9, h: 0.5,
            fontSize: 36, bold: true, color: colorScheme.primary,
            align: 'center', valign: 'middle', autoFit: true
        });

        const leftBulletPoints = (slideData.leftContent || []).map(point => ({
            text: point,
            options: { bullet: { color: colorScheme.secondary }, fontSize: 18, color: colorScheme.text, align: 'left' }
        }));
        slide.addText(leftBulletPoints, { x: 0.5, y: 1.3, w: 4.5, h: 3.5, autoFit: true, valign: 'top' });

        const rightBulletPoints = (slideData.rightContent || []).map(point => ({
            text: point,
            options: { bullet: { color: colorScheme.secondary }, fontSize: 18, color: colorScheme.text, align: 'left' }
        }));
        slide.addText(rightBulletPoints, { x: 5.5, y: 1.3, w: 4.5, h: 3.5, autoFit: true, valign: 'top' });
    }

    /**
     * Adds content for a visual slide.
     */
    addVisualSlideContent(slide, slideData, visualAnalysis, colorScheme, index) {
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: 9, h: 0.5,
            fontSize: 36, bold: true, color: colorScheme.primary,
            align: 'center', valign: 'middle', autoFit: true
        });

        if (slideData.visualConcept) {
            slide.addText(slideData.visualConcept, {
                x: 0.5, y: 1.0, w: 9, h: 0.5,
                fontSize: 24, color: colorScheme.text,
                align: 'center', valign: 'middle', autoFit: true, italic: true
            });
        }

        const patterns = this.vectorLibrary.patterns[visualAnalysis.category] || this.vectorLibrary.patterns.business;
        const selectedPattern = patterns[index % patterns.length];
        this.addVectorShape(slide, selectedPattern, 2.5, 1.8, 5, 3, colorScheme);

        const bulletPoints = (slideData.content || []).map(point => ({
            text: point,
            options: { fontSize: 16, color: colorScheme.text, align: 'center' }
        }));
        if (bulletPoints.length > 0) {
            slide.addText(bulletPoints, { x: 1, y: 4.8, w: 8, h: 0.6, valign: 'middle', autoFit: true });
        }
    }

    /**
     * Saves the presentation to a file.
     */
    async savePresentation(ppt, filename) {
        const uploadsDir = path.join(__dirname, '../../uploads/presentations');
        await fs.mkdir(uploadsDir, { recursive: true });
        const filepath = path.join(uploadsDir, filename);
        await ppt.writeFile({ fileName: filepath });

        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
        const downloadUrl = `${baseUrl}/uploads/presentations/${filename}`;
        return { filepath, downloadUrl };
    }
}

module.exports = new VectorPPTService();
