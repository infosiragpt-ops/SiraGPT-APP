'use strict';

/**
 * image-rag-corpus — Curated Visual Direction Knowledge Base & BM25 Retriever
 * for SiraGPT's Image Generation RAG ("el RAG de imágenes").
 *
 * Indexes 32 professional visual, photographic, typographic, architectural,
 * industrial, scientific, and illustration archetypes using SiraGPT's Okapi BM25
 * engine (`services/rag/bm25.js`) paired with the bilingual ES+EN stemmed
 * tokenizer (`services/rag/document-retrieval.js`), plus orthogonal optical,
 * lighting, color-mode, and studio-background facet modifiers.
 *
 * Hard policy invariants (AGENTS.md):
 *  - §10.3: Zero named-artist imitation — every archetype describes objective
 *    craft (optics, lighting rig, medium, composition, color science, surface
 *    fidelity), never living or named artists.
 *  - §12: Zero vendor or raw model_id strings in any prompt or metadata.
 */

const { createBm25Index } = require('../rag/bm25');
const { documentTokens } = require('../rag/document-retrieval');

const FRAME_COMPOSITION_SPECS = {
  '1:1': 'Balanced 1:1 square framing with deliberate figure-ground separation, clean breathing room around the focal subject, and controlled corner weight.',
  '16:9': 'Cinematic 16:9 widescreen composition using rule-of-thirds horizontal staging, layered foreground-midground-background depth, and clean lateral negative space.',
  '9:16': 'Vertical 9:16 mobile-first composition with strong central-vertical visual hierarchy, clear upper/lower safe zones, and full-height subject framing.',
  '3:4': 'Editorial 3:4 vertical portrait framing with natural headroom, balanced torso/subject proportions, and cohesive vertical rhythm.',
  '2:3': 'Classic 2:3 full-frame vertical ratio with elongated vertical flow, poised subject alignment, and generous top-to-bottom spatial balance.',
  '4:3': 'Classic 4:3 editorial horizontal frame with grounded subject placement, natural environmental context, and balanced margin tension.',
  '3:2': '35mm 3:2 reportage horizontal ratio with organic subject-to-environment proportion, leading lines, and crisp edge-to-edge balance.',
  square: 'Balanced 1:1 square framing with deliberate figure-ground separation and clean margins around the primary focal point.',
  wide: 'Panoramic 16:9 widescreen composition with strong horizontal staging, layered depth planes, and harmonious negative space.',
  portrait: 'Vertical portrait composition with natural headroom, strong vertical hierarchy, and clean subject isolation.',
};

/**
 * 32 domain-specialized visual direction playbooks.
 * Each entry provides structured photographic / design / illustration craft
 * that BM25 retrieves in <2 ms per turn.
 */
const IMAGE_RAG_ARCHETYPES = [
  {
    id: 'commercial_product_studio',
    category: 'photography',
    title: 'Commercial Studio Product Photography',
    keywords: 'producto comercial fotografia comercial estudio packshot ecommerce catalogo botella frasco perfume cosmetico reloj cafetera termo electrodomestico gadget auricular zapatilla calzado envase objeto lujo studio product shot hero commercial bottle skincare watch sneaker headphone coffee maker luxury item escaparate tienda',
    cameraAndOptics: 'Medium-format 80mm–100mm macro-capable studio prime at f/8–f/11, razor-sharp focus across the entire product silhouette, zero barrel distortion.',
    lightingAndColor: 'Three-point commercial studio rig: diffused overhead softbox key, sculpted strip-light rim highlights defining chamfers and edges, controlled bounce fill, calibrated neutral-true brand colors.',
    surfaceAndMaterial: 'Tactile micro-texture fidelity on glass, brushed metal, matte polymer, leather, condensation droplets, or embossed foil without plastic sheen.',
    antiArtifacts: 'Clean studio sweep or intentional podium, physically accurate contact shadow and reflections, zero warped geometry or asymmetrical product proportions.',
    preferTextFree: false,
  },
  {
    id: 'packaging_industrial_design',
    category: 'design',
    title: 'Packaging & Industrial Design Mockup',
    keywords: 'empaque packaging caja bolsa lata frasco etiqueta dieline prototipo industrial mockup envase carton kraft botella etiqueta marca presentacion box pouch tin jar label industrial design prototype',
    cameraAndOptics: 'Three-quarter hero angle on 70mm studio lens at f/9, crisp planar perspective preserving true die-cut edges and structural folds.',
    lightingAndColor: 'Controlled soft-gradient studio illumination highlighting paper grain, spot-UV gloss vs matte varnish contrast, and Pantone-accurate color blocks.',
    surfaceAndMaterial: 'Authentic substrate rendering: uncoated kraft fiber, embossed cardstock, metallic foil stamping, frosted glass, or anodized aluminum.',
    antiArtifacts: 'Plumb structural creases, clean label alignment wrapping naturally around curvature, no floating or detached packaging flaps.',
    preferTextFree: false,
  },
  {
    id: 'editorial_portrait',
    category: 'photography',
    title: 'Editorial & Lifestyle Portrait Photography',
    keywords: 'retrato persona mujer hombre rostro cara ejecutivo fundador modelo expresion mirada headshot perfil lifestyle humano gente nino anciano portrait woman man person face headshot founder actor candid',
    cameraAndOptics: '85mm prime lens at f/2.0–f/2.8 with creamy optical bokeh, tack-sharp focus on the near eye, natural facial perspective free of wide-angle nose distortion.',
    lightingAndColor: 'Rembrandt or butterfly key light through a large octabox (or golden-hour directional window light), subtle hair/shoulder rim separation, natural catchlights in both eyes, rich true-to-life skin undertones.',
    surfaceAndMaterial: 'Authentic human skin micro-texture with natural pores, fine hair strands, natural fabric weave, zero airbrushed waxy smoothing.',
    antiArtifacts: 'Anatomically natural hands, fingers, ears, teeth, and symmetrical iris geometry; natural posture and relaxed gaze.',
    preferTextFree: true,
  },
  {
    id: 'fashion_lookbook_campaign',
    category: 'photography',
    title: 'Fashion Lookbook & Apparel Campaign',
    keywords: 'moda ropa vestido traje camiseta prenda coleccion pasarela lookbook outfit estilismo textil tela modelo campaña editorial fashion apparel streetwear couture garment runway lookbook fabric',
    cameraAndOptics: '50mm–70mm full-frame editorial lens at f/4 capturing full garment silhouette, drape dynamics, and confident editorial stance.',
    lightingAndColor: 'High-contrast studio cyclorama or sculpted architectural sunlight, clean tonal separation between garment and backdrop, accurate textile dye saturation.',
    surfaceAndMaterial: 'Crisp textile weave, stitching seams, silk sheen, denim twill, knitwear volume, and natural gravity folds.',
    antiArtifacts: 'Coherent garment construction, symmetrical lapels/sleeves, natural limb proportions, clean footwear contact with the floor.',
    preferTextFree: true,
  },
  {
    id: 'architectural_exterior_interior',
    category: 'photography',
    title: 'Architectural & Interior Design Visualization',
    keywords: 'arquitectura edificio fachada casa departamento oficina sala cocina habitacion interiorismo inmobiliaria rascacielos ciudad puente museo hotel pabellon urbano architecture building interior room living kitchen facade cityscape urban real estate',
    cameraAndOptics: '24mm tilt-shift architectural lens at f/8–f/11 with strictly plumb two-point vertical lines, deep front-to-back sharpness, balanced spatial FOV.',
    lightingAndColor: 'Blue-hour or golden-hour natural daylight balanced with warm 2700K interior architectural fixtures, soft global illumination, realistic bounce light across walls and floors.',
    surfaceAndMaterial: 'Physically based rendering of board-formed concrete, warm oak timber, travertine stone, brushed brass, linen upholstery, and low-iron architectural glass.',
    antiArtifacts: 'Strictly vertical columns and wall edges, coherent stair/window grid geometry, realistic glass reflections without impossible room continuations.',
    preferTextFree: true,
  },
  {
    id: 'culinary_gastronomy',
    category: 'photography',
    title: 'Culinary & Beverage Editorial Photography',
    keywords: 'comida plato restaurante receta postre cafe bebida coctel vino pastel fruta pan pizza hamburguesa sushi gastronomia cocina ingrediente food dish culinary dessert coffee cocktail meal plating gourmet',
    cameraAndOptics: '50mm–90mm macro-editorial lens at f/3.5–f/5.6 (45° diner angle or crisp 90° flat-lay overhead), selective focus on the hero garnish.',
    lightingAndColor: 'Natural directional side-backlight from a diffused window, soft fill card preserving appetizing warm highlights, vibrant fresh ingredient colors.',
    surfaceAndMaterial: 'Glistening glazes, crisp sear crust, delicate steam wisps, fresh herb dew, artisanal ceramic stoneware, and linen napkin texture.',
    antiArtifacts: 'Appetizing organic food geometry, natural cutlery/glassware proportions, zero artificial waxy or oversaturated surfaces.',
    preferTextFree: true,
  },
  {
    id: 'brand_logo_monogram',
    category: 'design',
    title: 'Brand Identity Logo & Vector Mark',
    keywords: 'logo logotipo isotipo imagotipo monograma emblema escudo simbolo identidad corporativa marca icono vectorial minimalista wordmark brand mark emblem crest monogram identity symbol',
    cameraAndOptics: 'Flat 2D orthographic front-on presentation, centered on a clean solid-color canvas, zero perspective warp or unnecessary 3D mockup clutter unless requested.',
    lightingAndColor: 'Flat, uniform, high-contrast vector color palette (1–3 deliberate brand colors) with strong figure-ground legibility at both large and small scales.',
    surfaceAndMaterial: 'Precision Bezier vector curves, crisp geometric intersections, balanced stroke weights, intentional negative-space counterforms.',
    antiArtifacts: 'No noisy gradients, no photorealistic background clutter, no drop-shadow muddiness, no stray pseudo-letters.',
    preferTextFree: false,
  },
  {
    id: 'poster_cover_editorial_layout',
    category: 'design',
    title: 'Poster, Cover & Key-Art Editorial Layout',
    keywords: 'poster cartel afiche portada libro revista album pelicula evento concierto flyer folleto miniatura thumbnail portada youtube cover key art movie poster book cover album flyer',
    cameraAndOptics: 'Graphic editorial staging with a single unmistakable focal anchor, structured grid alignment, and dedicated negative-space zones for typographic hierarchy.',
    lightingAndColor: 'High-impact complementary or split-complementary color harmony, dramatic focal contrast guiding the eye from primary visual to headline zone.',
    surfaceAndMaterial: 'Cohesive print/editorial finish with crisp edge separation between foreground subject and typographic safe area.',
    antiArtifacts: 'Avoid overcrowded focal points; keep clean margins so titles or visual anchors never clip against frame borders.',
    preferTextFree: false,
  },
  {
    id: 'social_media_ad_banner',
    category: 'design',
    title: 'Social Campaign Banner & Digital Ad Creative',
    keywords: 'banner anuncio campaña redes sociales instagram tiktok linkedin facebook youtube cabecera header anuncio publicitario historia reel post promocion social media ad campaign header',
    cameraAndOptics: 'Scroll-stopping hero focal composition engineered for instant 1-second visual read, respecting platform safe zones and clear subject-background contrast.',
    lightingAndColor: 'Punchy commercial lighting, cohesive brand accent colors, clean tonal separation that remains legible on mobile and desktop screens.',
    surfaceAndMaterial: 'Polished commercial finish with crisp subject cutouts, clean studio or contextual environment, and balanced visual weight.',
    antiArtifacts: 'Keep essential subject elements safely away from extreme top/bottom UI crop margins; zero cluttered micro-details.',
    preferTextFree: false,
  },
  {
    id: 'infographic_schematic_diagram',
    category: 'diagram',
    title: 'Infographic, Technical Schematic & Visual Diagram',
    keywords: 'infografia diagrama esquema mapa mental proceso flujo arquitectura tecnica corte transversal explicativo educativo datos pasos estadistica infographic diagram schematic cutaway chart workflow architecture',
    cameraAndOptics: 'Clean orthographic or structured 2D/isometric layout on a crisp high-contrast neutral background, organized in clear visual modules and directional flow.',
    lightingAndColor: 'Color-coded functional palette (distinct semantic accent per stage/component) against a clean light or dark editorial canvas.',
    surfaceAndMaterial: 'Sharp vector iconography, consistent stroke widths, clear connector arrows, and structured visual hierarchy.',
    antiArtifacts: 'Avoid tangled overlapping connectors or illegible micro-labels; prioritize unmistakable visual iconography over dense paragraphs.',
    preferTextFree: false,
  },
  {
    id: 'ui_ux_product_mockup',
    category: 'design',
    title: 'UI/UX Digital Product & Dashboard Presentation',
    keywords: 'interfaz ui ux app aplicacion web dashboard pantalla software saas movil plataforma diseño web wireframe landing page interface screen mobile app dashboard mockup',
    cameraAndOptics: 'Clean front-facing or subtle perspective studio device/interface presentation with razor-sharp pixel grid alignment.',
    lightingAndColor: 'Modern design-system palette with WCAG-legible contrast, subtle elevation shadows, balanced whitespace, and cohesive accent tokens.',
    surfaceAndMaterial: 'Crisp card geometry, consistent border radii, clean data visualizations, and uncluttered navigation hierarchy.',
    antiArtifacts: 'No garbled lorem-ipsum walls, no misaligned buttons or warped screen bezels.',
    preferTextFree: false,
  },
  {
    id: 'isometric_3d_illustration',
    category: 'illustration',
    title: 'Isometric & Stylized 3D Render',
    keywords: 'isometrico isometric 3d render diorama icono 3d blender octane cinema4d clay estilizado maqueta cubo ecosistema tecnologia nube servidor 3d illustration stylized render',
    cameraAndOptics: 'True 30° orthographic isometric projection (or clean 50mm studio 3D stage) with crisp miniature-diorama depth and tidy silhouette.',
    lightingAndColor: 'Soft global illumination with ambient occlusion in crevices, pastel or vibrant studio rim lighting, harmonious color material palette.',
    surfaceAndMaterial: 'Tactile matte clay, frosted glassmorphism, anodized metal, and soft subsurface scattering on rounded bevels.',
    antiArtifacts: 'Clean non-intersecting 3D meshes, consistent isometric grid angles, smooth subdivision surfaces without polygon faceting.',
    preferTextFree: true,
  },
  {
    id: 'cinematic_film_still',
    category: 'photography',
    title: 'Cinematic Film Still & Narrative Staging',
    keywords: 'cinematografico cine pelicula escena fotograma dramatico thriller drama accion epico historia narrativa atmosfera anamorfico cinematic film still movie scene dramatic storytelling anamorphic',
    cameraAndOptics: '35mm–50mm anamorphic cinema prime at T2.0, shallow depth of field isolating the protagonist, subtle natural film halation and fine organic grain.',
    lightingAndColor: 'Motivated practical lighting + volumetric atmospheric haze, deliberate chiaroscuro shadow ratios, cohesive cinema color grade (warm tungsten vs cool slate shadows).',
    surfaceAndMaterial: 'Lived-in production design textures: weathered surfaces, authentic wardrobe patina, rain/dust/mist particulate catching backlight.',
    antiArtifacts: 'Grounded physical staging, consistent eye-lines, natural motion poise without theatrical stiffness.',
    preferTextFree: true,
  },
  {
    id: 'documentary_street_photojournalism',
    category: 'photography',
    title: 'Documentary & Street Reportage Photography',
    keywords: 'documental callejero calle reportaje periodistico cotidiano mercado ciudad viaje cultura autentico espontaneo natural 35mm documentary street photography candid reportage photojournalism',
    cameraAndOptics: '35mm reportage prime at f/4, natural eye-level human perspective, authentic environmental context framing the subject in action.',
    lightingAndColor: '100% available natural light (overcast open shade, late-afternoon street sun, or authentic indoor practicals), honest uncontrived color rendition.',
    surfaceAndMaterial: 'Unvarnished real-world textures, natural motion gesture, subtle 35mm film grain, zero studio polish.',
    antiArtifacts: 'Authentic human expressions and background crowd coherence; zero staged stock-photo artificiality.',
    preferTextFree: true,
  },
  {
    id: 'macro_scientific_botanical',
    category: 'photography',
    title: 'Macro, Botanical & Precision Close-Up Photography',
    keywords: 'macro primer plano insecto flor hoja gota rocio cristal ojo mecanismo textura micro detalle naturaleza botanica closeup dewdrop petal insect crystal microscopic',
    cameraAndOptics: '100mm 1:1 true macro lens with multi-plane focus stacking on the primary specimen and smooth creamy background falloff.',
    lightingAndColor: 'Diffused ring/twin-flash macro illumination revealing translucent veins, iridescent scales, or crystalline refraction without harsh blown speculars.',
    surfaceAndMaterial: 'Microscopic structural fidelity: pollen grains, water surface tension, chitin iridescence, velvet petal cells, or brushed horology gears.',
    antiArtifacts: 'Sharp specimen planes without motion blur or muddy chromatic aberration.',
    preferTextFree: true,
  },
  {
    id: 'scientific_medical_illustration',
    category: 'illustration',
    title: 'Scientific, Medical & Natural History Illustration',
    keywords: 'cientifico medico anatomia biologia celula organo musculo planta especie botanico enciclopedia didactico laboratorio quimica astronomia scientific medical anatomical biological botanical plate',
    cameraAndOptics: 'Didactic clear-view orthographic or three-quarter cross-section staging maximizing anatomical/structural legibility.',
    lightingAndColor: 'Clean studio neutral illumination with subtle form-modeling shading and accurate biological/scientific color differentiation.',
    surfaceAndMaterial: 'Precision scientific rendering combining fine contour definition with smooth tonal modeling on a clean neutral plate background.',
    antiArtifacts: 'Structurally coherent proportions, clean separation of layers/tissues/parts, clutter-free background.',
    preferTextFree: false,
  },
  {
    id: 'fine_art_oil_impasto',
    category: 'illustration',
    title: 'Traditional Oil & Acrylic Canvas Painting',
    keywords: 'oleo pintura lienzo pincelada acrilico impasto clasico cuadro galeria arte tradicional pictorico oil painting canvas brushwork impasto painterly fine art',
    cameraAndOptics: 'Painterly gallery composition with classic tonal massing, focal value contrast, and lost-and-found edges.',
    lightingAndColor: 'Chiaroscuro or luminous plein-air color temperature shifts, rich pigment mixing with warm glazes and cool shadow undertones.',
    surfaceAndMaterial: 'Tactile linen canvas weave, visible hog-bristle brushwork, expressive palette-knife impasto ridges, authentic oil pigment sheen.',
    antiArtifacts: 'Avoid flat digital airbrush gradients; maintain authentic physical paint materiality across the entire canvas.',
    preferTextFree: true,
  },
  {
    id: 'watercolor_ink_editorial',
    category: 'illustration',
    title: 'Watercolor Wash & Editorial Ink Illustration',
    keywords: 'acuarela tinta pluma dibujo boceto papel algodon acuarelas lavado editorial libreta sketch watercolor ink wash gouache botanical sketchbook',
    cameraAndOptics: 'Airy editorial book/magazine composition allowing generous unpainted paper white to act as highlights and breathing room.',
    lightingAndColor: 'Luminous transparent watercolor glazes, wet-on-wet pigment granulation, delicate warm-cool wash transitions.',
    surfaceAndMaterial: '300gsm cold-press cotton paper tooth, organic water-edge blooms, expressive fountain-pen or sumi-ink linework.',
    antiArtifacts: 'Preserve translucent paper luminosity rather than opaque digital muddiness.',
    preferTextFree: true,
  },
  {
    id: 'anime_manga_cel_illustration',
    category: 'illustration',
    title: 'Key-Visual Anime & Cel-Shaded Illustration',
    keywords: 'anime manga cel shaded japones otaku personaje shonen shojo chibi animacion japonesa novela ligera key visual anime illustration manga art',
    cameraAndOptics: 'Dynamic key-visual camera staging with expressive perspective, wind/motion flow lines, and clear character silhouette.',
    lightingAndColor: 'Crisp two-tone/three-tone cel shading paired with atmospheric sky/rim light bloom, saturated harmonious color scripting.',
    surfaceAndMaterial: 'Confident tapered ink line-art with varied line weight, expressive detailed eyes, and lush hand-painted scenic background art.',
    antiArtifacts: 'Consistent character proportions, clean cel shadow boundaries, symmetrical eye highlights, natural finger count.',
    preferTextFree: true,
  },
  {
    id: 'comic_graphic_novel_ligne_claire',
    category: 'illustration',
    title: 'Comic, Graphic Novel & Ligne-Claire Art',
    keywords: 'comic historieta novela grafica viñeta superheroe entintado linea clara pop art halftone caricatura comic book graphic novel inked ligne claire',
    cameraAndOptics: 'Bold sequential-art staging with dramatic foreshortening, crisp silhouette readability, and strong foreground-background contrast.',
    lightingAndColor: 'Deliberate spotted blacks, crisp ink hatching, and vibrant flat/halftone colorists palette.',
    surfaceAndMaterial: 'razor-clean brush/nib inking, deliberate contour hierarchy, classic print paper texture.',
    antiArtifacts: 'Clean ink closures without messy digital smudges or unintended speech bubbles unless requested.',
    preferTextFree: false,
  },
  {
    id: 'concept_art_worldbuilding',
    category: 'illustration',
    title: 'Environment & Character Concept Art',
    keywords: 'concept art fantasia mundo dragon castillo ruinas explorador guerrero criatura magia epico diseño de personajes escenario fantasy worldbuilding castle creature character design',
    cameraAndOptics: 'Wide environmental establishing shot with clear human/object scale cues, layered depth planes, and focal landmark silhouette.',
    lightingAndColor: 'Atmospheric aerial perspective, dramatic god-rays or bioluminescent accents guiding the eye directly to the narrative focal point.',
    surfaceAndMaterial: 'Richly designed cultural motifs, weathered stone/metal lore details, expressive painterly-digital hybrid brushwork.',
    antiArtifacts: 'Readable silhouette hierarchy without noisy over-greebling or muddy midtones.',
    preferTextFree: true,
  },
  {
    id: 'cyberpunk_scifi_futurism',
    category: 'illustration',
    title: 'Sci-Fi, Cyberpunk & Industrial Futurism',
    keywords: 'cyberpunk ciberpunk ciencia ficcion scifi futuro nave espacial robot androide neon holograma distopia estacion espacial mecha futuristic spaceship android neon',
    cameraAndOptics: 'Wide cinematic 28mm–35mm perspective emphasizing vertical megastructure scale and wet-street depth.',
    lightingAndColor: 'High-contrast neon cyan, magenta, and amber practical light sources reflecting across rain-slicked surfaces and atmospheric fog.',
    surfaceAndMaterial: 'Hard-surface industrial engineering: carbon fiber, weathered titanium plating, optical sensors, holographic light spill, rain-beadedvisor.',
    antiArtifacts: 'Coherent mechanical joints and hard-surface panel seams without melted cables.',
    preferTextFree: true,
  },
  {
    id: 'minimalist_flat_vector_icon',
    category: 'illustration',
    title: 'Minimalist Editorial Vector & Icon Illustration',
    keywords: 'minimalista plano flat vector geometrico icono sticker pegatina ilustracion corporativa web limpia simple silueta minimalist flat illustration geometric sticker',
    cameraAndOptics: 'Clean 2D geometric composition with generous negative space, crisp silhouette instant readability, and balanced visual weight.',
    lightingAndColor: 'Curated 3-to-5 color modern editorial palette with harmonious contrast and subtle grain or flat tonal planes.',
    surfaceAndMaterial: 'Smooth geometric curves, consistent corner radii, crisp die-cut outline if sticker, uncluttered background.',
    antiArtifacts: 'Zero stray anchor artifacts, muddy gradients, or unnecessary photorealistic noise.',
    preferTextFree: true,
  },
  {
    id: 'landscape_nature_astrophotography',
    category: 'photography',
    title: 'Landscape, Nature & Astrophotography',
    keywords: 'paisaje montaña bosque playa oceano mar lago rio cascada desierto cielo estrellas via lactea aurora atardecer amanecer naturaleza valle volcan landscape mountain ocean forest sunset sunrise nature',
    cameraAndOptics: '16mm–24mm wide-angle landscape prime at f/11 on tripod, hyperfocal sharpness from foreground anchor rocks/flora to distant horizon.',
    lightingAndColor: 'Golden-hour alpenglow, dramatic storm-break crepuscular rays, or crisp dark-sky astrophotography dynamic range with natural color gradations.',
    surfaceAndMaterial: 'Crisp geological rock strata, natural water motion/reflections, wind-swept foliage, and organic cloud volume.',
    antiArtifacts: 'Level horizon line, natural tonal transitions free of HDR haloing or oversaturated neon foliage.',
    preferTextFree: true,
  },
  {
    id: 'jewelry_horology_luxury',
    category: 'photography',
    title: 'Fine Jewelry, Haute Horology & Gemstone Studio',
    keywords: 'joya joyeria anillo collar pendiente arete pulsera brazalete diamante zafiro esmeralda rubi oro platino plata gema quilates alta relojeria cronografo suizo tourbillon esfera bisel jewelry ring necklace diamond gemstone luxury timepiece bracelet',
    cameraAndOptics: '100mm–120mm macro-apochromatic prime at f/14 with multi-plane focus stacking from prong settings to facet table, zero longitudinal chromatic aberration.',
    lightingAndColor: 'Precision dark-field light-tent diffusion paired with pinpoint specular accent kickers to ignite diamond fire/dispersion while sculpting smooth metallic gradients.',
    surfaceAndMaterial: 'Mirror-polished 18k gold/platinum, crisp bevel chamfers, internal gemstone facet refraction, guilloché dial engraving, and anti-reflective sapphire crystal.',
    antiArtifacts: 'Symmetrical gemstone prongs, concentric watch bezel/subdial geometry, zero muddy black reflections or blown-out white hotspots.',
    preferTextFree: true,
  },
  {
    id: 'automotive_transport_studio',
    category: 'photography',
    title: 'Automotive, Motorsport & Industrial Mobility',
    keywords: 'automovil coche carro auto superdeportivo deportivo suv camioneta motocicleta moto tren avion jet yate barco velero carroceria neumatico circuito carretera automotive sports car vehicle motorcycle yacht aviation',
    cameraAndOptics: '35mm–70mm polarized automotive lens at f/5.6–f/8 (three-quarter low hero stance or dynamic panning tracking shot), crisp wheel-to-fender stance.',
    lightingAndColor: 'Continuous overhead studio light-bank or dramatic twilight road reflections tracing uninterrupted highlight ribbons along the shoulder line and hood.',
    surfaceAndMaterial: 'Deep metallic-flake clearcoat, exposed twill carbon fiber, machined alloy rims, ceramic brake calipers, and optical headlamp internals.',
    antiArtifacts: 'Circular true-ellipse wheels, coherent panel gaps, symmetrical grille/headlights, physically grounded tire-to-asphalt contact.',
    preferTextFree: true,
  },
  {
    id: 'interior_real_estate_staging',
    category: 'photography',
    title: 'Interior Design, Hospitality & Living Space Staging',
    keywords: 'interiorismo decoracion de interiores sala de estar comedor dormitorio recamara baño suite de hotel lobby recepcion mobiliario sofa sillon alfombra lampara cortinas penthouse loft interior design living room bedroom dining hospitality furniture staging',
    cameraAndOptics: '24mm rectilinear architectural lens positioned at 1.3m chest height with strictly plumb vertical wall corners and inviting room depth.',
    lightingAndColor: 'Soft directional window daylight balanced with warm 2700K architectural sconces and table lamps, natural shadow falloff, calm editorial color harmony.',
    surfaceAndMaterial: 'Tactile bouclé and linen upholstery, honed marble countertops, herringbone oak flooring, hand-knotted wool rug weave, and ceramic decor.',
    antiArtifacts: 'Plumb doorframes and cabinetry, four-legged furniture resting flat on floor plane, coherent mirror reflections.',
    preferTextFree: true,
  },
  {
    id: 'data_chart_executive_slide',
    category: 'diagram',
    title: 'Executive Data Visualization, KPI Chart & Analytics Graphic',
    keywords: 'grafico de barras grafico de lineas grafica circular pastel kpi metricas reporte ejecutivo comparativa financiera estadisticas embudo matriz cuadrante tendencias dashboard analitico bar chart line graph pie chart executive metrics analytics',
    cameraAndOptics: 'Flat orthographic 2D presentation canvas with strict baseline grid alignment, generous margins, and clear visual hierarchy.',
    lightingAndColor: 'High-contrast accessible categorical palette (distinct semantic series colors) over a clean editorial light or deep-slate canvas.',
    surfaceAndMaterial: 'Crisp vector bars/curves, uniform axis ticks, clean data-point markers, zero 3D perspective distortion or skeuomorphic chartjunk.',
    antiArtifacts: 'Uncluttered axis spacing, distinct non-overlapping series shapes, zero garbled pseudo-numbers.',
    preferTextFree: false,
  },
  {
    id: 'childrens_storybook_whimsical',
    category: 'illustration',
    title: 'Children’s Picture-Book & Whimsical Narrative Illustration',
    keywords: 'cuento infantil libro para niños ilustrado infantil fabula tierno amigable bosque encantado animalitos personajes infantiles gouache lapices de colores crayola pastel childrens book picture book storybook whimsical fairy tale',
    cameraAndOptics: 'Warm child-eye-level narrative staging with clear focal storytelling gesture, cozy foreground framing, and inviting spatial depth.',
    lightingAndColor: 'Warm golden storybook illumination, gentle pastel-and-ochre color scripting, soft dappled light creating a comforting magical mood.',
    surfaceAndMaterial: 'Hand-crafted gouache, colored-pencil grain, and soft pastel textures over warm textured cotton book paper.',
    antiArtifacts: 'Expressive friendly faces, consistent character proportions, clear silhouette separation without harsh photorealistic uncanny textures.',
    preferTextFree: true,
  },
  {
    id: 'pixel_art_retro_game',
    category: 'illustration',
    title: 'Precision 16-Bit / 32-Bit Pixel Art & Retro Game Scene',
    keywords: 'pixel art pixelart pixelado 8bit 16bit 32bit arcade retro videojuego clasico consola sprite tileset rpg retro game art pixel sprite',
    cameraAndOptics: 'Crisp integer-aligned orthographic or side-view/top-down game staging with unmistakable pixel-grid discipline.',
    lightingAndColor: 'Curated limited palette ramp with deliberate hue-shifted shadows, structured dithering transitions, and punchy arcade contrast.',
    surfaceAndMaterial: 'Hand-placed pixel clusters, clean 1px sel-out contours, crisp nearest-neighbor sharp edges without post-process blur.',
    antiArtifacts: 'Zero mixed pixel sizes ("mixels"), zero rotated non-grid pixels, zero smooth airbrush gradients or JPEG ringing.',
    preferTextFree: true,
  },
  {
    id: 'vintage_analog_film_polaroid',
    category: 'photography',
    title: 'Vintage 35mm / Medium-Format Analog Film & Instant Print',
    keywords: 'vintage retro analogico pelicula fotografica 35mm 120mm grano de pelicula instantanea polaroid años 70 años 80 años 90 nostalgia epoca sepia carrete analog film grain nostalgic instant photo',
    cameraAndOptics: 'Classic 50mm f/1.8 vintage prime optical signature with gentle corner vignette, natural center sharpness, and organic lens character.',
    lightingAndColor: 'Authentic silver-halide color chemistry: warm highlight halation, softly lifted matte shadow toe, nostalgic warm-amber and muted-cyan split tones.',
    surfaceAndMaterial: 'Organic emulsion film grain structure, authentic vintage wardrobe/prop textures, natural unretouched skin and surfaces.',
    antiArtifacts: 'Authentic era-consistent details without modern plastic sheen or artificial digital scratch overlays.',
    preferTextFree: true,
  },
  {
    id: 'abstract_generative_editorial_art',
    category: 'illustration',
    title: 'Abstract Geometric, Fluid & Contemporary Gallery Art',
    keywords: 'abstracto arte abstracto contemporaneo formas geometricas fluido ondas escultura digital gradiente artistico fondo de pantalla minimalismo escultorico galeria moderna abstract art geometric fluid sculpture contemporary',
    cameraAndOptics: 'Intentional golden-ratio or asymmetric tension composition with poised negative space and clear focal rhythm.',
    lightingAndColor: 'Sophisticated gallery color harmony combining luminous translucent gradients, subtle caustics, and tonal depth.',
    surfaceAndMaterial: 'Tactile sculptural materiality: Dichroic glass refraction, brushed mineral stone, flowing silk ribbons, or layered pigment planes.',
    antiArtifacts: 'Clean intentional edges and smooth curvature free of chaotic noisy banding or accidental representational artifacts.',
    preferTextFree: true,
  },
];

const ARCHETYPE_BY_ID = new Map(IMAGE_RAG_ARCHETYPES.map((item) => [item.id, item]));

/**
 * Orthogonal optical, lighting, color-mode, and studio-background facet
 * modifiers. Composed on top of the primary domain archetype whenever the
 * user's prompt requests a specific camera angle, lighting hour, color
 * treatment, or isolated background.
 */
const VISUAL_FACET_MODIFIERS = [
  {
    id: 'flat_lay_overhead',
    group: 'angle',
    re: /\b(?:vista\s+cenital|toma\s+cenital|angulo\s+cenital|desde\s+arriba|flat[\s-]?lay|top[\s-]?down|overhead\s+(?:shot|view|angle))\b/i,
    clause: 'Camera angle: True 90° zenithal overhead flat-lay perpendicular to the surface with zero keystone tilt.',
  },
  {
    id: 'low_angle_hero',
    group: 'angle',
    re: /\b(?:contrapicad[oa]|angulo\s+bajo|toma\s+baja|desde\s+abajo|low[\s-]?angle|worm'?s[\s-]?eye|hero\s+angle)\b/i,
    clause: 'Camera angle: Dramatic low-angle hero perspective looking upward to emphasize stature and monumental presence.',
  },
  {
    id: 'aerial_drone',
    group: 'angle',
    re: /\b(?:vista\s+aerea|toma\s+aerea|con\s+dron|vuelo\s+de\s+pajaro|aerial\s+(?:view|shot)|drone\s+(?:shot|view)|bird'?s[\s-]?eye\s+view)\b/i,
    clause: 'Camera angle: High-altitude aerial perspective with crisp spatial scale and expansive horizon geometry.',
  },
  {
    id: 'golden_hour',
    group: 'lighting',
    re: /\b(?:hora\s+dorada|luz\s+dorada|golden\s+hour|magic\s+hour)\b/i,
    clause: 'Lighting mood: Warm low-sun golden-hour directional light casting long soft shadows and luminous amber rim highlights.',
  },
  {
    id: 'blue_hour',
    group: 'lighting',
    re: /\b(?:hora\s+azul|crepusculo\s+azul|blue\s+hour|twilight\s+dusk)\b/i,
    clause: 'Lighting mood: Deep cobalt blue-hour twilight sky balanced against warm practical interior or street glow.',
  },
  {
    id: 'backlit_rim',
    group: 'lighting',
    re: /\b(?:a\s+contraluz|contraluz|silueta\s+iluminada|backlit|rim[\s-]?lit|rim\s+lighting|contre[\s-]?jour)\b/i,
    clause: 'Lighting mood: Pronounced contre-jour backlighting carving a crisp luminous rim halo around the subject silhouette.',
  },
  {
    id: 'rain_wet_reflections',
    group: 'lighting',
    re: /\b(?:bajo\s+la\s+lluvia|calles?\s+mojad[oa]s|asfalto\s+mojado|rain[\s-]?slicked|pouring\s+rain|wet\s+street\s+reflections)\b/i,
    clause: 'Atmosphere: Coherent rainfall with specular wet-surface mirror reflections and crisp water droplets.',
  },
  {
    id: 'monochrome_bw',
    group: 'color',
    re: /\b(?:blanco\s+y\s+negro|en\s+escala\s+de\s+grises|monocromatic[oa]|black\s+and\s+white|b&w|monochrome|silver\s+gelatin)\b/i,
    clause: 'Color treatment: Strict monochrome black-and-white tonal scale with rich silver-gelatin blacks, nuanced midtones, and zero color cast.',
  },
  {
    id: 'pastel_palette',
    group: 'color',
    re: /\b(?:colores\s+pastel|tonos\s+pastel|paleta\s+pastel|pastel\s+(?:palette|colors|tones))\b/i,
    clause: 'Color treatment: Harmonious low-saturation high-key pastel palette with gentle tonal transitions.',
  },
  {
    id: 'pure_white_cutout',
    group: 'background',
    re: /\b(?:sobre\s+fondo\s+blanco(?:\s+puro)?|fondo\s+blanco\s+puro|aislad[oa]\s+(?:en|sobre)\s+blanco|(?:on\s+)?pure\s+white\s+background|isolated\s+on\s+white|white\s+studio\s+sweep)\b/i,
    clause: 'Backdrop: Isolated cleanly on a seamless pure #FFFFFF white studio sweep with subtle grounded contact shadow and zero background clutter.',
  },
  {
    id: 'dark_low_key_studio',
    group: 'background',
    re: /\b(?:sobre\s+fondo\s+negro(?:\s+puro)?|fondo\s+negro\s+puro|clave\s+baja|pure\s+black\s+background|low[\s-]?key\s+(?:studio|lighting))\b/i,
    clause: 'Backdrop: Dramatic low-key dark studio backdrop with controlled light falloff and zero stray spill.',
  },
];

function normalizeFacetQuery(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect orthogonal optical, lighting, color-mode, and studio-background
 * modifiers requested in the user's prompt (at most one per group, max 3 total).
 */
function detectVisualFacetModifiers(query) {
  const norm = normalizeFacetQuery(query);
  if (!norm) return [];
  const picked = [];
  const usedGroups = new Set();
  for (const mod of VISUAL_FACET_MODIFIERS) {
    if (usedGroups.has(mod.group)) continue;
    if (mod.re.test(norm)) {
      usedGroups.add(mod.group);
      picked.push({ id: mod.id, group: mod.group, clause: mod.clause });
      if (picked.length >= 3) break;
    }
  }
  return picked;
}

// Map explicit `style` enum values from `generate_image` / `image-directive`
// to boosted archetype families while still allowing the subject's own domain
// (e.g. "estilo realista" + "botella de perfume") to select the specialized
// archetype (`commercial_product_studio`).
const STYLE_ENUM_BOOSTS = {
  realistic: ['editorial_portrait', 'commercial_product_studio', 'architectural_exterior_interior', 'landscape_nature_astrophotography', 'automotive_transport_studio', 'interior_real_estate_staging'],
  photographic: ['editorial_portrait', 'documentary_street_photojournalism', 'commercial_product_studio', 'landscape_nature_astrophotography', 'vintage_analog_film_polaroid'],
  natural: ['documentary_street_photojournalism', 'editorial_portrait', 'landscape_nature_astrophotography'],
  anime: ['anime_manga_cel_illustration'],
  'oil-painting': ['fine_art_oil_impasto'],
  'line-art': ['watercolor_ink_editorial', 'comic_graphic_novel_ligne_claire', 'minimalist_flat_vector_icon'],
  'digital-art': ['concept_art_worldbuilding', 'isometric_3d_illustration', 'cyberpunk_scifi_futurism', 'abstract_generative_editorial_art'],
  vivid: [],
};

const IMAGE_TYPE_BOOSTS = {
  logo: 'brand_logo_monogram',
  poster: 'poster_cover_editorial_layout',
  cover: 'social_media_ad_banner',
  portrait: 'editorial_portrait',
  avatar: 'editorial_portrait',
  landscape: 'landscape_nature_astrophotography',
  sticker: 'minimalist_flat_vector_icon',
  infographic: 'infographic_schematic_diagram',
  diagram: 'infographic_schematic_diagram',
  chart: 'data_chart_executive_slide',
  product: 'commercial_product_studio',
  packaging: 'packaging_industrial_design',
  ui: 'ui_ux_product_mockup',
};

let _corpusIndex = null;

function tokenizeVisualCorpus(text) {
  return documentTokens(String(text || ''));
}

function getCorpusIndex() {
  if (_corpusIndex) return _corpusIndex;
  const idx = createBm25Index({ k1: 1.35, b: 0.65, tokenize: tokenizeVisualCorpus });
  idx.addBatch(
    IMAGE_RAG_ARCHETYPES.map((arch) => ({
      id: arch.id,
      text: `${arch.title} ${arch.category} ${arch.keywords} ${arch.cameraAndOptics} ${arch.surfaceAndMaterial}`,
    }))
  );
  _corpusIndex = idx;
  return _corpusIndex;
}

/**
 * Tailor prompt phrasing density & emphasis to the target model family
 * WITHOUT ever emitting vendor names or raw model_ids.
 */
function resolveModelFamilyGuidance(model) {
  const m = String(model || '').trim().toLowerCase();
  if (!m) return { family: 'generic', hint: '' };
  if (m.includes('gpt-image') || m.includes('gpt-5-image') || m.includes('dall-e')) {
    return {
      family: 'gpt-image',
      hint: 'Coherent spatial staging with exact adherence to stated attributes, lighting hierarchy, and crisp edge definition.',
    };
  }
  if (m.includes('imagen')) {
    return {
      family: 'imagen',
      hint: 'Optical photographic realism, physically grounded light transport, and natural tonal dynamic range.',
    };
  }
  if (m.includes('gemini') && m.includes('image')) {
    return {
      family: 'gemini-image',
      hint: 'Clear subject-to-background separation, accurate spatial relationships, and faithful material textures.',
    };
  }
  if (m.includes('flux')) {
    return {
      family: 'flux',
      hint: 'Rich natural-language visual staging with tactile surface micro-detail and physically motivated illumination.',
    };
  }
  if (m.includes('grok')) {
    return {
      family: 'grok-image',
      hint: 'Crisp focal subject definition, atmospheric depth, and balanced color contrast.',
    };
  }
  return { family: 'generic', hint: '' };
}

/**
 * Retrieve the best-matching visual direction archetype(s) for a prompt.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {string} [opts.style]
 * @param {string} [opts.imageType]
 * @param {string} [opts.aspectRatio]
 * @param {string} [opts.model]
 * @param {string} [opts.facetQuery]
 * @returns {{ primary: object, secondary: object|null, frameSpec: string, modelGuidance: object, facets: Array, score: number }}
 */
function searchVisualDirectionCorpus(query, opts = {}) {
  const index = getCorpusIndex();
  const rawHits = index.search(String(query || ''), { topK: 6 });
  const scoreMap = new Map(rawHits.map((h) => [h.id, h.score]));

  const styleKey = String(opts.style || '').trim().toLowerCase();
  const boostedIds = STYLE_ENUM_BOOSTS[styleKey] || [];
  for (const id of boostedIds) {
    scoreMap.set(id, (scoreMap.get(id) || 0) + (styleKey === 'anime' || styleKey === 'oil-painting' ? 4.5 : 1.6));
  }

  const typeKey = String(opts.imageType || '').trim().toLowerCase();
  const boostedType = IMAGE_TYPE_BOOSTS[typeKey];
  if (boostedType) {
    scoreMap.set(boostedType, (scoreMap.get(boostedType) || 0) + 3.2);
  }

  const ranked = [...scoreMap.entries()]
    .filter(([id, sc]) => ARCHETYPE_BY_ID.has(id) && sc > 0)
    .sort((a, b) => b[1] - a[1]);

  let primary = ranked.length > 0 ? ARCHETYPE_BY_ID.get(ranked[0][0]) : null;
  const topScore = ranked.length > 0 ? ranked[0][1] : 0;

  if (!primary) {
    if (styleKey === 'anime') primary = ARCHETYPE_BY_ID.get('anime_manga_cel_illustration');
    else if (styleKey === 'oil-painting') primary = ARCHETYPE_BY_ID.get('fine_art_oil_impasto');
    else if (styleKey === 'line-art') primary = ARCHETYPE_BY_ID.get('watercolor_ink_editorial');
    else if (styleKey === 'digital-art') primary = ARCHETYPE_BY_ID.get('concept_art_worldbuilding');
    else primary = ARCHETYPE_BY_ID.get('cinematic_film_still');
  }

  let secondary = null;
  if (ranked.length >= 2 && topScore > 0) {
    const candidate = ARCHETYPE_BY_ID.get(ranked[1][0]);
    if (candidate && candidate.id !== primary.id && ranked[1][1] >= topScore * 0.68) {
      secondary = candidate;
    }
  }

  const ratioKey = String(opts.aspectRatio || '').trim();
  const frameSpec = FRAME_COMPOSITION_SPECS[ratioKey] || FRAME_COMPOSITION_SPECS['1:1'];
  const modelGuidance = resolveModelFamilyGuidance(opts.model);
  const facets = detectVisualFacetModifiers(opts.facetQuery !== undefined ? opts.facetQuery : query);

  return {
    primary,
    secondary,
    frameSpec,
    modelGuidance,
    facets,
    score: Number(topScore.toFixed(3)),
  };
}

module.exports = {
  IMAGE_RAG_ARCHETYPES,
  ARCHETYPE_BY_ID,
  FRAME_COMPOSITION_SPECS,
  VISUAL_FACET_MODIFIERS,
  getCorpusIndex,
  detectVisualFacetModifiers,
  resolveModelFamilyGuidance,
  searchVisualDirectionCorpus,
};
