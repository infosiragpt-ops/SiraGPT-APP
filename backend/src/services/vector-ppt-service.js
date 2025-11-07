// Vector-based Presentation Service - Gamma.app style
// Generates presentations with AI-analyzed content and pure vector graphics

const PptxGenJS = require('pptxgenjs');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs').promises;

class VectorPPTService {
    constructor() {
        this.vectorLibrary = this.initializeVectorLibrary();
    }

    /**
     * Initialize vector graphics library with shapes and patterns
     */
    initializeVectorLibrary() {
        return {
            colorSchemes: {
                professional: { primary: '0d47a1', secondary: '1976d2', accent: '42a5f5', background: 'e3f2fd', text: '000000' },
                creative: { primary: '4a148c', secondary: '7b1fa2', accent: 'ab47bc', background: 'f3e5f5', text: '000000' },
                energetic: { primary: 'b71c1c', secondary: 'd32f2f', accent: 'f44336', background: 'ffebee', text: '000000' },
                calm: { primary: '1b5e20', secondary: '2e7d32', accent: '4caf50', background: 'e8f5e9', text: '000000' },
                modern: { primary: '212121', secondary: '424242', accent: '757575', background: 'f5f5f5', text: '000000' }
            }
        };
    }

    /**
     * Analyze content and determine appropriate visual style
     */
    async analyzeContentForVisuals(content, provider = "OpenAI") {
        try {
            const client = this.getClient(provider);
            
            const analysisPrompt = `Analyze this presentation content and determine the mood/tone (professional/creative/energetic/calm/modern).

Content: ${JSON.stringify(content)}

Respond with JSON only:
{
    "mood": "professional"
}`;

            const response = await client.chat.completions.create({
                model: provider === "Gemini" ? "gemini-pro" : "gpt-4o-mini",
                messages: [
                    { role: 'system', content: 'You are a visual design expert. Analyze content and suggest a visual mood.' },
                    { role: 'user', content: analysisPrompt }
                ],
                temperature: 0.2,
            });

            const analysisText = response.choices[0].message.content;
            const jsonMatch = analysisText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, analysisText];
            return JSON.parse(jsonMatch[1].trim());
        } catch (error) {
            console.error('Content analysis error:', error);
            return { mood: 'professional' };
        }
    }

    /**
     * Get AI client based on provider
     */
    getClient(provider) {
        if (provider === "Gemini") {
            return new OpenAI({
                apiKey: process.env.GEMINI_API_KEY,
                baseURL: "https://generativelanguage.googleapis.com/v1beta/",
            });
        }
        return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    // LAYOUT FUNCTIONS
    addTitleLayout(slide, colors, data) {
        slide.addShape('rect', { x: 0, y: 0, w: '30%', h: '100%', fill: { color: colors.primary, transparency: 85 } });
        slide.addShape('rect', { x: '10%', y: '15%', w: '80%', h: '70%', fill: { color: 'FFFFFF' }, shadow: { type: 'outer', color: '333333', blur: 10, offset: 5, angle: 45, opacity: 0.2 } });
        
        slide.addText(data.title, { x: '12%', y: '40%', w: '76%', h: '20%', fontSize: 36, bold: true, color: colors.primary, align: 'center', valign: 'middle', autoFit: true });
        if (data.subtitle) {
            slide.addText(data.subtitle, { x: '12%', y: '60%', w: '76%', h: '10%', fontSize: 18, color: colors.secondary, align: 'center' });
        }
    }

    addContentLayout(slide, colors, data, index) {
        const layoutChoice = index % 2;

        if (layoutChoice === 0) {
            slide.addShape('rect', { x: 0, y: 0, w: '100%', h: 1, fill: { color: colors.primary } });
            slide.addText(data.title, { x: 0.5, y: 0.2, w: 9, h: 0.6, fontSize: 28, bold: true, color: 'FFFFFF', valign: 'middle' });
            
            slide.addShape('rect', { x: 9.5, y: 1, w: 0.5, h: '80%', fill: { color: colors.accent, transparency: 80 } });

            const bulletPoints = data.content.map(point => ({
                text: point,
                options: { fontSize: 14, color: colors.text, bullet: { type: 'number', style: 'romanLcPeriod' }, paraSpaceAfter: 10 }
            }));
            slide.addText(bulletPoints, { x: 0.5, y: 1.2, w: 8.5, h: 4, autoFit: true });
        } else {
            slide.addShape('rect', { x: 0, y: 0, w: 0.5, h: '100%', fill: { color: colors.primary } });
            slide.addText(data.title, { x: 0.8, y: 0.2, w: 9, h: 0.6, fontSize: 28, bold: true, color: colors.primary, valign: 'middle' });

            const bulletPoints = data.content.map(point => ({
                text: point,
                options: { fontSize: 14, color: colors.text, bullet: { code: '25CF' }, paraSpaceAfter: 10 }
            }));
            slide.addText(bulletPoints, { x: 1.0, y: 1.2, w: 8.5, h: 4, autoFit: true });
        }
    }

    addTwoColumnLayout(slide, colors, data) {
        slide.addShape('rect', { x: 0, y: 0, w: '100%', h: 1, fill: { color: colors.primary } });
        slide.addText(data.title, { x: 0.5, y: 0.2, w: 9, h: 0.6, fontSize: 28, bold: true, color: 'FFFFFF', valign: 'middle' });

        slide.addShape('line', { x: 5, y: 1.2, w: 0, h: 4, line: { color: colors.accent, width: 2, dashType: 'dash' } });

        const leftBullets = data.leftContent.map(point => ({ text: point, options: { fontSize: 12, color: colors.text, bullet: true, paraSpaceAfter: 8 } }));
        slide.addText(leftBullets, { x: 0.5, y: 1.2, w: 4.2, h: 4, autoFit: true });

        const rightBullets = data.rightContent.map(point => ({ text: point, options: { fontSize: 12, color: colors.text, bullet: true, paraSpaceAfter: 8 } }));
        slide.addText(rightBullets, { x: 5.3, y: 1.2, w: 4.2, h: 4, autoFit: true });
    }

    addVisualLayout(slide, colors, data, index) {
        const isTextOnLeft = index % 2 === 0;
        const textX = isTextOnLeft ? 0.5 : 5.5;
        const shapeX = isTextOnLeft ? 5.0 : 0;

        slide.addShape('rect', { x: shapeX, y: 0, w: '50%', h: '100%', fill: { color: colors.secondary, transparency: 80 } });
        slide.addShape('arc', { x: shapeX, y: 0, w: 6, h: 6, angleRange: [0, 90], fill: { color: colors.primary, transparency: 85 } });

        slide.addText(data.title, { x: textX, y: 0.5, w: 4.5, h: 0.8, fontSize: 28, bold: true, color: colors.primary, autoFit: true });
        
        const bulletPoints = (data.content || []).map(point => ({ text: point, options: { fontSize: 14, color: colors.text, bullet: { code: '2713' }, paraSpaceAfter: 10 } }));
        slide.addText(bulletPoints, { x: textX, y: 1.5, w: 4.5, h: 3.5, autoFit: true });
    }

    addProcessLayout(slide, colors, data) {
        slide.addShape('rect', { x: 0, y: 0, w: '100%', h: 1, fill: { color: colors.primary } });
        slide.addText(data.title, { x: 0.5, y: 0.2, w: 9, h: 0.6, fontSize: 28, bold: true, color: 'FFFFFF', align: 'center' });

        const steps = data.steps || [];
        const stepCount = steps.length;
        const stepWidth = 8 / stepCount;
        const arrowWidth = 0.5;

        steps.forEach((step, i) => {
            const xPos = 1 + i * (stepWidth);
            slide.addShape('roundRect', {
                x: xPos, y: 2.5, w: stepWidth - arrowWidth, h: 1.5,
                fill: { color: colors.accent, transparency: 30 },
                line: { color: colors.primary, width: 1.5 }
            });
            slide.addText(step, {
                x: xPos, y: 2.5, w: stepWidth - arrowWidth, h: 1.5,
                fontSize: 12, bold: true, color: colors.primary, align: 'center', valign: 'middle', autoFit: true
            });

            if (i < stepCount - 1) {
                slide.addShape('rightArrow', {
                    x: xPos + stepWidth - arrowWidth, y: 3, w: arrowWidth, h: 0.5,
                    fill: { color: colors.secondary, transparency: 50 }
                });
            }
        });
    }

    /**
     * Generate complete vector-based presentation
     */
    async generateVectorPresentation(prompt, provider = "OpenAI", model = "gpt-4o") {
        try {
            const client = this.getClient(provider);

            // Step 1: Generate presentation structure
            const structurePrompt = {
                role: 'system',
                content: `You are an expert presentation creator. Create a professional presentation structure.
Return ONLY valid JSON with this exact format:
{
  "title": "Presentation Title",
  "slides": [
    { "type": "title", "title": "Main Title", "subtitle": "Engaging subtitle" },
    { "type": "content", "title": "Slide Title", "content": ["Point 1", "Point 2", "Point 3"] },
    { "type": "two-column", "title": "Comparison", "leftContent": ["Left point 1"], "rightContent": ["Right point 1"] },
    { "type": "visual", "title": "Visual Slide", "content": ["Key point 1", "Key point 2"] },
    { "type": "process", "title": "Process Flow", "steps": ["Step 1", "Step 2", "Step 3"] }
  ]
}

Types: "title", "content", "two-column", "visual", "process". Generate 6-8 slides.`
            };

            console.log('🎨 Generating presentation structure...');
            const structureResponse = await client.chat.completions.create({
                model: model, messages: [structurePrompt, { role: 'user', content: `Create a presentation about: ${prompt}` }]
            });

            const responseText = structureResponse.choices[0].message.content;
            const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, responseText];
            const pptStructure = JSON.parse(jsonMatch[1].trim());

            // Step 2: Analyze content for visual design
            console.log('🎨 Analyzing content for vector design...');
            const visualAnalysis = await this.analyzeContentForVisuals(pptStructure, provider);
            const colorScheme = this.vectorLibrary.colorSchemes[visualAnalysis.mood] || this.vectorLibrary.colorSchemes.professional;

            // Step 3: Create PowerPoint
            const ppt = new PptxGenJS();
            ppt.author = 'AI Vector Designer';
            ppt.subject = pptStructure.title;
            ppt.title = pptStructure.title;

            const timestamp = Date.now();

            // Step 4: Create slides with varied layouts
            for (const [index, slideData] of pptStructure.slides.entries()) {
                const slide = ppt.addSlide({ layout: 'LAYOUT_16x9' });
                slide.background = { color: colorScheme.background };

                switch (slideData.type) {
                    case 'title':
                        this.addTitleLayout(slide, colorScheme, slideData);
                        break;
                    case 'content':
                        this.addContentLayout(slide, colorScheme, slideData, index);
                        break;
                    case 'two-column':
                        this.addTwoColumnLayout(slide, colorScheme, slideData);
                        break;
                    case 'visual':
                        this.addVisualLayout(slide, colorScheme, slideData, index);
                        break;
                    case 'process':
                        this.addProcessLayout(slide, colorScheme, slideData);
                        break;
                    default:
                        this.addContentLayout(slide, colorScheme, slideData, index);
                }
                
                slide.addText(`${index + 1}`, { x: 9.2, y: 5.2, w: 0.5, h: 0.3, fontSize: 10, color: colorScheme.secondary, align: 'right' });
            }

            // Step 5: Save presentation
            const uploadsDir = path.join(__dirname, '../../uploads/presentations');
            await fs.mkdir(uploadsDir, { recursive: true });
            const filename = `vector-presentation-${timestamp}.pptx`;
            const filepath = path.join(uploadsDir, filename);
            await ppt.writeFile({ fileName: filepath });

            const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
            const downloadUrl = `${baseUrl}/uploads/presentations/${filename}`;

            console.log('✅ Vector presentation generated successfully:', filename);

            return {
                filename,
                downloadUrl,
                structure: pptStructure,
                slideCount: pptStructure.slides.length,
                colorScheme: visualAnalysis.mood,
                category: visualAnalysis.category || 'general'
            };

        } catch (error) {
            console.error('❌ Error generating vector presentation:', error);
            throw error;
        }
    }
}

module.exports = new VectorPPTService();
