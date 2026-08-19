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
                technology: ['hexagon', 'circuit', 'grid', 'network', 'chip', 'binary', 'server'],
                business: ['arrow', 'chart', 'growth', 'target', 'briefcase', 'handshake', 'pyramid'],
                education: ['book', 'bulb', 'brain', 'pencil', 'atom', 'dna', 'compass'],
                health: ['heart', 'pulse', 'cross', 'shield', 'microscope', 'caduceus', 'firstaid'],
                finance: ['coin', 'graph', 'trend', 'bar', 'bank', 'wallet', 'piggybank'],
                marketing: ['megaphone', 'funnel', 'magnet', 'rocket', 'piechart', 'target', 'social'],
                data: ['database', 'cloud', 'server', 'analytics', 'flowchart', 'gears', 'dashboard']
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
        if (provider === "DeepSeek") {
            return new OpenAI({
                apiKey: process.env.DEEPSEEK_API_KEY,
                baseURL: "https://api.deepseek.com",
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
        { "slideIndex": 0, "concepts": ["innovation", "growth", "future"], "vectorType": "network" }
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
            const filename = `presentation-${timestamp}.pptx`;
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
            content: `You are a world-class expert presentation creator. Your task is to generate a professional, data-rich, and visually stunning presentation structure.
Return ONLY valid JSON with this exact format:
{
  "title": "Presentation Title",
  "slides": [
    { "type": "title", "title": "Main Title", "subtitle": "A highly engaging and informative subtitle that sets the tone." },
    { "type": "points-with-visual", "title": "Core Topic Explained", "content": ["Expert-level point with in-depth explanation and examples.", ["Detailed sub-point 1.1.", "Detailed sub-point 1.2."], "Another expert-level point with comprehensive details."] },
    { "type": "diagram", "title": "Critical Process Flow", "steps": ["Step 1: In-depth description", "Step 2: In-depth description", "Step 3: In-depth description"] },
    { "type": "bar-chart", "title": "Key Performance Metrics", "data": [{ "name": "Metric A", "value": 50 }, { "name": "Metric B", "value": 75 }, { "name": "Metric C", "value": 60 }] },
    { "type": "pie-chart", "title": "Resource Allocation", "data": [{ "name": "Resource X", "value": 50 }, { "name": "Resource Y", "value": 25 }, { "name": "Resource Z", "value": 25 }] },
    { "type": "two-column", "title": "Pros and Cons Analysis", "leftContent": ["Detailed advantage with supporting facts."], "rightContent": ["Detailed disadvantage with supporting facts."] }
  ]
}
Slide Types Available: "title", "points-with-visual", "diagram", "bar-chart", "pie-chart", "two-column".
ABSOLUTELY CRITICAL INSTRUCTIONS:
- Generate 10-15 slides for a truly comprehensive and expert-level presentation.
- Every single slide MUST have substantial, detailed, and deeply informative content. Shallow or sparse content is unacceptable.
- For "points-with-visual" slides, provide expert-level explanations for each bullet point and use nested arrays for sub-points to create maximum depth.
- Use 'bar-chart' or 'pie-chart' whenever the content involves statistics, data, or comparisons to make it visually engaging.
- Use 'diagram' for processes or sequential information, ensuring each step is well-explained.`
        };

        const response = await client.chat.completions.create({
            model,
            messages: [structurePrompt, { role: 'user', content: `Create a presentation about: ${prompt}` }]
        });

        const responseText = response.choices[0].message.content;
        try {
            const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, responseText];
            return JSON.parse(jsonMatch[1].trim());
        } catch (error) {
            console.error("Failed to parse JSON, attempting recovery:", error);
            const startIndex = responseText.indexOf('{');
            const endIndex = responseText.lastIndexOf('}');
            if (startIndex > -1 && endIndex > -1) {
                const jsonString = responseText.substring(startIndex, endIndex + 1);
                try {
                    return JSON.parse(jsonString);
                } catch (e) {
                    console.error("JSON recovery failed.");
                    throw e;
                }
            }
            throw error;
        }
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
            case 'diagram':
                this.addDiagramSlideContent(slide, slideData, colorScheme);
                break;
            case 'bar-chart':
                this.addBarChartSlideContent(slide, slideData, colorScheme);
                break;
            case 'pie-chart':
                this.addPieChartSlideContent(slide, slideData, colorScheme);
                break;
            case 'points-with-visual':
                this.addPointsWithVisualSlideContent(slide, slideData, visualAnalysis, colorScheme, index);
                break;
            case 'two-column':
                this.addTwoColumnSlideContent(slide, slideData, colorScheme);
                break;
            default:
                this.addPointsWithVisualSlideContent(slide, slideData, visualAnalysis, colorScheme, index);
        }
    }

    /**
     * Adds content for a diagram/flowchart slide.
     */
    addDiagramSlideContent(slide, slideData, colorScheme) {
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: 9, h: 0.5,
            fontSize: 36, bold: true, color: colorScheme.primary,
            align: 'center', valign: 'middle', autoFit: true,
            effect: { name: 'fadeIn', duration: 0.5, delay: 0.2 }
        });

        const steps = slideData.steps || [];
        const stepCount = steps.length;
        if (stepCount < 2 || stepCount > 4) {
            this.addPointsWithVisualSlideContent(slide, { ...slideData, content: steps, title: slideData.title }, { slides: [] }, colorScheme, 0);
            return;
        }

        const contentAreaWidth = 9.0;
        const shapeWidth = (contentAreaWidth - (stepCount * 0.5)) / stepCount;
        const shapeHeight = 1.8;
        const yPos = 2.0;
        const arrowWidth = 0.4;

        const totalShapesWidth = stepCount * shapeWidth;
        const totalArrowsWidth = (stepCount - 1) * arrowWidth;
        const startX = 0.5 + (contentAreaWidth - totalShapesWidth - totalArrowsWidth) / 2;

        let currentX = startX;

        steps.forEach((step, index) => {
            slide.addText(step, {
                shape: 'roundRect',
                x: currentX, y: yPos, w: shapeWidth, h: shapeHeight,
                fill: { color: colorScheme.background },
                line: { color: colorScheme.accent, width: 1 },
                shadow: { type: 'outer', color: '000000', blur: 3, offset: 2, angle: 45, opacity: 0.2 },
                color: colorScheme.text,
                align: 'center',
                valign: 'middle',
                fontSize: 14,
                autoFit: true,
                effect: { name: 'fadeIn', duration: 0.5, delay: 0.4 * (index + 1) }
            });

            if (index < stepCount - 1) {
                const arrowX = currentX + shapeWidth;
                slide.addShape('rightArrow', {
                    x: arrowX, y: yPos + (shapeHeight / 2) - 0.2, w: arrowWidth, h: 0.4,
                    fill: { color: colorScheme.secondary }
                });
                currentX += shapeWidth + arrowWidth;
            }
        });
    }

    /**
     * Adds content for a bar chart slide.
     */
    addBarChartSlideContent(slide, slideData, colorScheme) {
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: 9, h: 0.5,
            fontSize: 36, bold: true, color: colorScheme.primary,
            align: 'center', valign: 'middle', autoFit: true,
            effect: { name: 'fadeIn', duration: 0.5, delay: 0.2 }
        });

        const chartData = (slideData.data || []).map(item => ({
            name: item.name,
            labels: [item.name],
            values: [item.value]
        }));

        slide.addChart('bar', chartData, {
            x: 1.0, y: 1.2, w: 8.0, h: 4.0,
            barDir: 'col',
            showValue: true,
            valueColor: '333333',
            valueFontSize: 14,
            catAxisLabelColor: colorScheme.text,
            valAxisLabelColor: colorScheme.text,
            showLegend: false,
            chartColors: [colorScheme.primary, colorScheme.secondary, colorScheme.accent]
        });
    }

    /**
     * Adds content for a pie chart slide.
     */
    addPieChartSlideContent(slide, slideData, colorScheme) {
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: 9, h: 0.5,
            fontSize: 36, bold: true, color: colorScheme.primary,
            align: 'center', valign: 'middle', autoFit: true,
            effect: { name: 'fadeIn', duration: 0.5, delay: 0.2 }
        });

        const chartData = [{
            name: 'Market Share',
            labels: (slideData.data || []).map(item => item.name),
            values: (slideData.data || []).map(item => item.value)
        }];

        slide.addChart('pie', chartData, {
            x: 1.0, y: 1.2, w: 8.0, h: 4.0,
            showValue: true,
            dataLabelColor: 'FFFFFF',
            dataLabelFontSize: 14,
            showLegend: true,
            legendPos: 'r',
            legendColor: colorScheme.text,
            chartColors: [colorScheme.primary, colorScheme.secondary, colorScheme.accent, 'F97316', '6EE7B7']
        });
    }

    /**
     * Adds content for a title slide.
     */
    addTitleSlideContent(slide, slideData, colorScheme) {
        slide.addText(slideData.title, {
            x: 0.5, y: 1.8, w: 9, h: 1.5,
            fontSize: 48, bold: true, color: colorScheme.primary,
            align: 'center', valign: 'middle', autoFit: true,
            effect: { name: 'fadeIn', duration: 1, delay: 0.5 }
        });
        if (slideData.subtitle) {
            slide.addText(slideData.subtitle, {
                x: 0.5, y: 3.3, w: 9, h: 0.8,
                fontSize: 24, color: colorScheme.text,
                align: 'center', autoFit: true,
                effect: { name: 'fadeIn', duration: 1, delay: 1 }
            });
        }
    }

    /**
     * Adds content for a standard content slide.
     */
    addPointsWithVisualSlideContent(slide, slideData, visualAnalysis, colorScheme, index) {
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: 9, h: 0.5,
            fontSize: 36, bold: true, color: colorScheme.primary,
            align: 'left', valign: 'middle', autoFit: true,
            effect: { name: 'fadeIn', duration: 0.5, delay: 0.2 }
        });

        const bulletPoints = (slideData.content || []).map(point => {
            if (Array.isArray(point)) {
                return {
                    text: point.join('\n'),
                    options: { bullet: { color: colorScheme.secondary }, indentLevel: 1, fontSize: 16, color: colorScheme.text, align: 'left' }
                };
            }
            return {
                text: point,
                options: { bullet: { color: colorScheme.primary }, fontSize: 18, color: colorScheme.text, align: 'left' }
            };
        });
        slide.addText(bulletPoints, {
            x: 0.5, y: 1.3, w: 9, h: 3.8, autoFit: true, valign: 'top',
            paraSpc: 10,
            effect: { name: 'fadeIn', duration: 0.5, delay: 0.5, by: 'paragraph' }
        });
    }

    /**
     * Adds content for a two-column slide.
     */
    addTwoColumnSlideContent(slide, slideData, colorScheme) {
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: 9, h: 0.5,
            fontSize: 36, bold: true, color: colorScheme.primary,
            align: 'center', valign: 'middle', autoFit: true,
            effect: { name: 'fadeIn', duration: 0.5, delay: 0.2 }
        });

        const processPoints = (content) => (content || []).map(point => {
            if (Array.isArray(point)) {
                return { text: point.join('\n'), options: { bullet: { color: colorScheme.secondary }, indentLevel: 1, fontSize: 16 } };
            }
            return { text: point, options: { bullet: { color: colorScheme.primary }, fontSize: 18 } };
        });

        slide.addText(processPoints(slideData.leftContent), {
            x: 0.5, y: 1.3, w: 4.5, h: 3.5, autoFit: true, valign: 'top', color: colorScheme.text,
            paraSpc: 10, effect: { name: 'fadeIn', duration: 0.5, delay: 0.5, by: 'paragraph' }
        });

        slide.addText(processPoints(slideData.rightContent), {
            x: 5.5, y: 1.3, w: 4.5, h: 3.5, autoFit: true, valign: 'top', color: colorScheme.text,
            paraSpc: 10, effect: { name: 'fadeIn', duration: 0.5, delay: 0.5, by: 'paragraph' }
        });
    }

    /**
     * Adds content for a visual slide.
     */
    addVisualSlideContent(slide, slideData, visualAnalysis, colorScheme, index) {
        slide.addText(slideData.title, {
            x: 0.5, y: 0.3, w: 9, h: 0.5,
            fontSize: 36, bold: true, color: colorScheme.primary,
            align: 'center', valign: 'middle', autoFit: true,
            effect: { name: 'fadeIn', duration: 0.5, delay: 0.2 }
        });

        const slideAnalysis = visualAnalysis.slides.find(s => s.slideIndex === index);
        const selectedPattern = slideAnalysis ? slideAnalysis.vectorType : (this.vectorLibrary.patterns[visualAnalysis.category] || this.vectorLibrary.patterns.business)[index % (this.vectorLibrary.patterns[visualAnalysis.category] || this.vectorLibrary.patterns.business).length];
        this.addVectorShape(slide, selectedPattern, 2.5, 1.5, 5, 3.5, colorScheme);

        const contentText = (slideData.content || []).join('\n');
        if (contentText) {
            slide.addText(contentText, {
                x: 1, y: 4.8, w: 8, h: 0.6,
                fontSize: 20, color: colorScheme.text,
                align: 'center', valign: 'middle', autoFit: true,
                effect: { name: 'fadeIn', duration: 0.5, delay: 0.5 }
            });
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
