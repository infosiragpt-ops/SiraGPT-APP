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
            // Geometric patterns for different content types
            patterns: {
                technology: ['hexagon', 'circuit', 'grid', 'network'],
                business: ['arrow', 'chart', 'growth', 'target'],
                education: ['book', 'bulb', 'brain', 'pencil'],
                health: ['heart', 'pulse', 'cross', 'shield'],
                finance: ['coin', 'graph', 'trend', 'bar'],
                marketing: ['megaphone', 'funnel', 'magnet', 'rocket'],
                data: ['database', 'cloud', 'server', 'analytics']
            },
            
            // Color schemes based on content mood
            colorSchemes: {
                professional: {
                    primary: '1e3a8a',
                    secondary: '3b82f6',
                    accent: '60a5fa',
                    background: 'f0f9ff',
                    text: '1e293b'
                },
                creative: {
                    primary: '7c3aed',
                    secondary: 'a78bfa',
                    accent: 'c4b5fd',
                    background: 'faf5ff',
                    text: '1e293b'
                },
                energetic: {
                    primary: 'dc2626',
                    secondary: 'f97316',
                    accent: 'fbbf24',
                    background: 'fef2f2',
                    text: '1e293b'
                },
                calm: {
                    primary: '059669',
                    secondary: '10b981',
                    accent: '6ee7b7',
                    background: 'f0fdf4',
                    text: '1e293b'
                },
                modern: {
                    primary: '0f172a',
                    secondary: '475569',
                    accent: '94a3b8',
                    background: 'f8fafc',
                    text: '0f172a'
                }
            }
        };
    }

    /**
     * Analyze content and determine appropriate visual style
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
        {
            "slideIndex": 0,
            "concepts": ["innovation", "growth", "future"],
            "vectorType": "network",
            "emphasis": "high"
        }
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
            // Return default analysis
            return {
                category: 'business',
                mood: 'professional',
                slides: []
            };
        }
    }

    /**
     * Get AI client based on provider
     */
    getClient(provider) {
        if (provider === "Gemini") {
            return new OpenAI({
                apiKey: process.env.GEMINI_API_KEY,
                baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
            });
        }
        return new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    /**
     * Add geometric vector shape to slide
     */
    addVectorShape(slide, shapeType, x, y, w, h, colors) {
        const shapes = {
            hexagon: () => {
                // Multiple hexagons pattern
                const hexSize = 0.8;
                const positions = [
                    [x, y], [x + 1, y], [x + 2, y],
                    [x + 0.5, y + 0.7], [x + 1.5, y + 0.7],
                    [x, y + 1.4], [x + 1, y + 1.4], [x + 2, y + 1.4]
                ];
                
                positions.forEach(([px, py]) => {
                    slide.addShape('hexagon', {
                        x: px, y: py, w: hexSize, h: hexSize,
                        fill: { color: colors.accent, transparency: 60 },
                        line: { color: colors.primary, width: 2 }
                    });
                });
            },
            
            circuit: () => {
                // Circuit board pattern
                for (let i = 0; i < 5; i++) {
                    slide.addShape('line', {
                        x: x + i * 0.7, y: y, w: 0, h: h,
                        line: { color: colors.secondary, width: 3, dashType: 'dash' }
                    });
                }
                // Add circuit nodes
                for (let i = 0; i < 8; i++) {
                    slide.addShape('ellipse', {
                        x: x + (i % 4) * 1, y: y + Math.floor(i / 4) * 2,
                        w: 0.3, h: 0.3,
                        fill: { color: colors.primary }
                    });
                }
            },
            
            network: () => {
                // Network nodes pattern
                const nodes = [
                    [x + 1, y + 0.5], [x + 3, y + 0.5], [x + 5, y + 0.5],
                    [x + 2, y + 2], [x + 4, y + 2],
                    [x + 1, y + 3.5], [ x + 3, y + 3.5], [x + 5, y + 3.5]
                ];
                
                // Connection lines
                nodes.forEach((node, i) => {
                    if (i < nodes.length - 1) {
                        slide.addShape('line', {
                            x: node[0], y: node[1],
                            w: nodes[i + 1][0] - node[0],
                            h: nodes[i + 1][1] - node[1],
                            line: { color: colors.accent, width: 2, transparency: 50 }
                        });
                    }
                });
                
                // Nodes
                nodes.forEach(([nx, ny]) => {
                    slide.addShape('ellipse', {
                        x: nx - 0.2, y: ny - 0.2, w: 0.4, h: 0.4,
                        fill: { color: colors.primary },
                        line: { color: colors.secondary, width: 2 }
                    });
                });
            },
            
            growth: () => {
                // Growth arrow with steps
                const steps = 5;
                for (let i = 0; i < steps; i++) {
                    const height = (i + 1) * 0.6;
                    slide.addShape('rect', {
                        x: x + i * 1, y: y + (3 - height), w: 0.8, h: height,
                        fill: { color: colors.secondary, transparency: 30 + i * 10 },
                        line: { color: colors.primary, width: 2 }
                    });
                }
                // Arrow on top
                slide.addShape('rightArrow', {
                    x: x + 1.5, y: y - 0.5, w: 2.5, h: 0.8,
                    fill: { color: colors.accent },
                    line: { color: colors.primary, width: 2 }
                });
            },
            
            funnel: () => {
                // Marketing funnel
                slide.addShape('trapezoid', {
                    x: x, y: y, w: w, h: h * 0.3,
                    fill: { color: colors.primary, transparency: 30 },
                    line: { color: colors.primary, width: 2 },
                    flipV: true
                });
                slide.addShape('trapezoid', {
                    x: x + 0.5, y: y + h * 0.3, w: w - 1, h: h * 0.35,
                    fill: { color: colors.secondary, transparency: 30 },
                    line: { color: colors.secondary, width: 2 },
                    flipV: true
                });
                slide.addShape('trapezoid', {
                    x: x + 1, y: y + h * 0.65, w: w - 2, h: h * 0.35,
                    fill: { color: colors.accent, transparency: 30 },
                    line: { color: colors.accent, width: 2 },
                    flipV: true
                });
            },
            
            analytics: () => {
                // Data analytics visualization
                const bars = 6;
                for (let i = 0; i < bars; i++) {
                    const barHeight = Math.random() * 2 + 1;
                    slide.addShape('rect', {
                        x: x + i * 0.8, y: y + (3 - barHeight), w: 0.6, h: barHeight,
                        fill: { color: i % 2 === 0 ? colors.primary : colors.secondary, transparency: 20 },
                        line: { color: colors.primary, width: 2 }
                    });
                }
                // Trend line
                slide.addShape('line', {
                    x: x, y: y + 2.5, w: w - 1, h: -1.5,
                    line: { color: colors.accent, width: 3 }
                });
            },
            
            grid: () => {
                // Modern grid pattern
                for (let i = 0; i < 4; i++) {
                    for (let j = 0; j < 4; j++) {
                        const opacity = (i + j) % 3 === 0 ? 40 : 20;
                        slide.addShape('rect', {
                            x: x + i * 1.2, y: y + j * 1, w: 1, h: 0.8,
                            fill: { color: colors.accent, transparency: opacity },
                            line: { color: colors.primary, width: 1 }
                        });
                    }
                }
            }
        };

        const shapeFunction = shapes[shapeType] || shapes.grid;
        shapeFunction();
    }

    /**
     * Add decorative vector background
     */
    addVectorBackground(slide, vectorType, colors) {
        // Subtle geometric background
        slide.addShape('rect', {
            x: 0, y: 0, w: '100%', h: '100%',
            fill: { color: colors.background }
        });

        // Add decorative elements based on type
        if (vectorType === 'modern') {
            // Diagonal stripes
            for (let i = 0; i < 15; i++) {
                slide.addShape('line', {
                    x: -2 + i * 1, y: 0, w: 2, h: 6,
                    line: { color: colors.accent, width: 20, transparency: 95 }
                });
            }
        } else if (vectorType === 'circles') {
            // Floating circles
            const circles = [
                [8, 0.5, 1.5], [0.5, 4, 1], [9, 5, 1.2], [1, 1, 0.8]
            ];
            circles.forEach(([cx, cy, size]) => {
                slide.addShape('ellipse', {
                    x: cx, y: cy, w: size, h: size,
                    fill: { color: colors.accent, transparency: 90 },
                    line: { color: colors.secondary, width: 2, transparency: 80 }
                });
            });
        }
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
    {
      "type": "title",
      "title": "Main Title",
      "subtitle": "Engaging subtitle"
    },
    {
      "type": "content",
      "title": "Slide Title",
      "content": ["Point 1", "Point 2", "Point 3", "Point 4"]
    },
    {
      "type": "two-column",
      "title": "Comparison",
      "leftContent": ["Left point 1", "Left point 2"],
      "rightContent": ["Right point 1", "Right point 2"]
    },
    {
      "type": "visual",
      "title": "Visual Slide",
      "content": ["Key point 1", "Key point 2"],
      "visualConcept": "growth and innovation"
    }
  ]
}

Types: "title", "content", "two-column", "visual"
Generate 6-10 slides. Each content slide needs 4-6 detailed points.`
            };

            console.log('🎨 Generating presentation structure...');
            const structureResponse = await client.chat.completions.create({
                model: model,
                messages: [
                    structurePrompt,
                    { role: 'user', content: `Create a presentation about: ${prompt}` }
                ]
            });

            const responseText = structureResponse.choices[0].message.content;
            const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, responseText];
            const pptStructure = JSON.parse(jsonMatch[1].trim());

            // Step 2: Analyze content for visual design
            console.log('🎨 Analyzing content for vector design...');
            const visualAnalysis = await this.analyzeContentForVisuals(pptStructure, provider);

            // Step 3: Select color scheme
            const colorScheme = this.vectorLibrary.colorSchemes[visualAnalysis.mood] || 
                              this.vectorLibrary.colorSchemes.professional;

            // Step 4: Create PowerPoint with vector graphics
            const ppt = new PptxGenJS();
            ppt.author = 'AI Vector Designer';
            ppt.subject = pptStructure.title;
            ppt.title = pptStructure.title;

            // Define layout
            ppt.defineLayout({ name: 'CUSTOM', width: 10, height: 5.625 });
            ppt.layout = 'CUSTOM';

            const timestamp = Date.now();

            // Step 5: Create slides with vector graphics
            for (const [index, slideData] of pptStructure.slides.entries()) {
                const slide = ppt.addSlide();
                
                if (slideData.type === 'title') {
                    // Title slide with vector background
                    this.addVectorBackground(slide, 'modern', colorScheme);
                    
                    // Add abstract vector shape
                    this.addVectorShape(slide, 'network', 6, 1, 3, 3, colorScheme);
                    
                    // Title text
                    slide.addText(slideData.title, {
                        x: 0.5, y: 1.8, w: 5, h: 1.5,
                        fontSize: 48, bold: true, color: colorScheme.primary,
                        align: 'left', valign: 'middle'
                    });
                    
                    if (slideData.subtitle) {
                        slide.addText(slideData.subtitle, {
                            x: 0.5, y: 3.3, w: 5, h: 0.8,
                            fontSize: 24, color: colorScheme.text,
                            align: 'left'
                        });
                    }
                    
                } else if (slideData.type === 'content') {
                    // Content slide with subtle background
                    this.addVectorBackground(slide, 'circles', colorScheme);
                    
                    // Title bar with gradient effect
                    slide.addShape('rect', {
                        x: 0, y: 0, w: '100%', h: 1,
                        fill: { color: colorScheme.primary, transparency: 5 }
                    });
                    
                    slide.addText(slideData.title, {
                        x: 0.5, y: 0.3, w: 9, h: 0.5,
                        fontSize: 36, bold: true, color: colorScheme.primary
                    });
                    
                    // Content with custom bullets
                    const bulletPoints = slideData.content.map(point => ({
                        text: point,
                        options: {
                            bullet: { code: '●', color: colorScheme.secondary },
                            fontSize: 18,
                            color: colorScheme.text,
                            paraSpaceAfter: 12
                        }
                    }));
                    
                    slide.addText(bulletPoints, {
                        x: 0.8, y: 1.5, w: 8.5, h: 3.5
                    });
                    
                } else if (slideData.type === 'two-column') {
                    // Two-column with vector divider
                    this.addVectorBackground(slide, 'circles', colorScheme);
                    
                    slide.addText(slideData.title, {
                        x: 0.5, y: 0.3, w: 9, h: 0.5,
                        fontSize: 36, bold: true, color: colorScheme.primary
                    });
                    
                    // Vertical divider with style
                    slide.addShape('rect', {
                        x: 4.9, y: 1.2, w: 0.2, h: 3.8,
                        fill: { color: colorScheme.accent, transparency: 30 }
                    });
                    
                    // Left column
                    const leftBullets = slideData.leftContent.map(point => ({
                        text: point,
                        options: {
                            bullet: { code: '▸', color: colorScheme.secondary },
                            fontSize: 16,
                            color: colorScheme.text
                        }
                    }));
                    slide.addText(leftBullets, {
                        x: 0.5, y: 1.5, w: 4.2, h: 3.5
                    });
                    
                    // Right column
                    const rightBullets = slideData.rightContent.map(point => ({
                        text: point,
                        options: {
                            bullet: { code: '▸', color: colorScheme.secondary },
                            fontSize: 16,
                            color: colorScheme.text
                        }
                    }));
                    slide.addText(rightBullets, {
                        x: 5.3, y: 1.5, w: 4.2, h: 3.5
                    });
                    
                } else if (slideData.type === 'visual') {
                    // Visual slide with large vector graphic
                    this.addVectorBackground(slide, 'circles', colorScheme);
                    
                    slide.addText(slideData.title, {
                        x: 0.5, y: 0.3, w: 4.5, h: 0.5,
                        fontSize: 36, bold: true, color: colorScheme.primary
                    });
                    
                    // Content on left
                    const bulletPoints = (slideData.content || []).map(point => ({
                        text: point,
                        options: {
                            bullet: { code: '●', color: colorScheme.secondary },
                            fontSize: 18,
                            color: colorScheme.text
                        }
                    }));
                    slide.addText(bulletPoints, {
                        x: 0.5, y: 1.3, w: 4.5, h: 3.5
                    });
                    
                    // Large vector graphic on right
                    const patterns = this.vectorLibrary.patterns[visualAnalysis.category] || 
                                   this.vectorLibrary.patterns.business;
                    const selectedPattern = patterns[index % patterns.length];
                    this.addVectorShape(slide, selectedPattern, 5.5, 1.2, 4, 3.8, colorScheme);
                }
                
                // Add slide number
                slide.addText(`${index + 1}`, {
                    x: 9.2, y: 5.2, w: 0.5, h: 0.3,
                    fontSize: 12, color: colorScheme.secondary, align: 'right'
                });
            }

            // Step 6: Save presentation
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
                category: visualAnalysis.category
            };

        } catch (error) {
            console.error('❌ Error generating vector presentation:', error);
            throw error;
        }
    }
}

module.exports = new VectorPPTService();
