// backend/src/services/ppt-vector-backgrounds.js

/**
 * Adds a modern background with diagonal stripes.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {object} colors - The color scheme object.
 */
const addModernBackground = (slide, colors) => {
    for (let i = 0; i < 15; i++) {
        slide.addShape('line', {
            x: -2 + i * 1, y: 0, w: 2, h: 6,
            line: { color: colors.accent, width: 20, transparency: 95 }
        });
    }
};

/**
 * Adds a background with floating circles.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {object} colors - The color scheme object.
 */
const addCirclesBackground = (slide, colors) => {
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
};

/**
 * Adds a gradient background.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {object} colors - The color scheme object.
 */
const addGradientBackground = (slide, colors) => {
    slide.addShape('rect', {
        x: 0, y: 0, w: '100%', h: '100%',
        fill: {
            type: 'gradient',
            colors: [colors.background, colors.accent],
            angle: 45,
            transparency: [90, 100]
        }
    });
};

/**
 * Adds a subtle geometric pattern background.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {object} colors - The color scheme object.
 */
const addGeometricBackground = (slide, colors) => {
    for (let i = 0; i < 5; i++) {
        slide.addShape('triangle', {
            x: Math.random() * 10, y: Math.random() * 5,
            w: Math.random() * 1 + 0.5, h: Math.random() * 1 + 0.5,
            fill: { color: colors.accent, transparency: 95 },
            rotate: Math.random() * 360
        });
    }
};

const backgroundStyles = {
    modern: addModernBackground,
    circles: addCirclesBackground,
    gradient: addGradientBackground,
    geometric: addGeometricBackground,
};

/**
 * Adds a decorative vector background to the slide.
 * @param {object} slide - The slide object from PptxGenJS.
 * @param {string} style - The style of the background.
 * @param {object} colors - The color scheme object.
 */
const addVectorBackground = (slide, style, colors) => {
    slide.addShape('rect', {
        x: 0, y: 0, w: '100%', h: '100%',
        fill: { color: colors.background }
    });

    const styleFunction = backgroundStyles[style] || backgroundStyles.modern;
    styleFunction(slide, colors);
};

module.exports = { addVectorBackground, backgroundStyles };
