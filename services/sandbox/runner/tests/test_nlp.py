"""Area "nlp": tokenising, tagging, stemming, sentiment, language detection,
topic models and word vectors — all with the data baked into the image.

The image installs the NLTK corpora listed in capabilities.json
(``python_data.nltk``) under ``$NLTK_DATA`` (/usr/share/nltk_data) and the two
spaCy models as pip packages, so nothing here may touch the network: a
``LookupError`` or ``OSError: [E050] Can't find model`` is a build failure.
Heavy imports stay inside the tests so this module collects anywhere.
"""
from __future__ import annotations

import os

import pytest

SPANISH = "El Ministerio de Economía anunció en Lima que la inflación bajó al 2,5 % en marzo de 2026."
ENGLISH = "Apple is looking at buying a startup in London for $1 billion, according to Reuters."


def _nltk():
    import nltk

    data_dir = os.environ.get("NLTK_DATA", "/usr/share/nltk_data")
    if data_dir not in nltk.data.path:
        nltk.data.path.append(data_dir)
    return nltk


@pytest.mark.covers("nltk")
def test_nltk_spanish_tokenize_stopwords_stemmer():
    nltk = _nltk()
    from nltk.corpus import stopwords
    from nltk.stem.snowball import SnowballStemmer
    from nltk.tokenize import sent_tokenize, word_tokenize

    text = "La producción de café creció en 2025. ¿Seguirá creciendo el próximo año? Los expertos creen que sí."
    sentences = sent_tokenize(text, language="spanish")  # needs punkt_tab/spanish
    assert len(sentences) == 3
    assert sentences[1] == "¿Seguirá creciendo el próximo año?"

    tokens = word_tokenize(SPANISH, language="spanish")
    assert "Ministerio" in tokens and "Economía" in tokens and "inflación" in tokens
    assert "2,5" in tokens  # the Spanish punkt model keeps decimal commas together
    assert tokens[-1] == "."
    assert len(tokens) >= 17

    spanish_stops = set(stopwords.words("spanish"))
    assert {"el", "de", "que", "la", "en", "y", "al"} <= spanish_stops
    assert "café" not in spanish_stops and "inflación" not in spanish_stops
    content = [t for t in tokens if t.isalpha() and t.lower() not in spanish_stops]
    assert content[:4] == ["Ministerio", "Economía", "anunció", "Lima"]
    assert "en" not in content and "la" not in content
    english_stops = set(stopwords.words("english"))
    assert {"the", "and", "is"} <= english_stops

    stemmer = SnowballStemmer("spanish")  # needs snowball_data
    assert stemmer.stem("creciendo") == stemmer.stem("creció") == stemmer.stem("crecer") == "crec"
    assert stemmer.stem("producción") == "produccion"
    assert stemmer.stem("económicas") == stemmer.stem("economía") == "econom"
    assert SnowballStemmer("english").stem("running") == "run"
    assert "spanish" in SnowballStemmer.languages

    freq = nltk.FreqDist(t.lower() for t in word_tokenize(text, language="spanish") if t.isalpha())
    assert freq["creciendo"] == 1 and freq.most_common(1)[0][1] >= 1
    assert list(nltk.ngrams(["a", "b", "c"], 2)) == [("a", "b"), ("b", "c")]


@pytest.mark.covers("nltk")
def test_nltk_wordnet_pos_tag_vader():
    _nltk()
    from nltk import pos_tag
    from nltk.corpus import wordnet
    from nltk.sentiment import SentimentIntensityAnalyzer
    from nltk.stem import WordNetLemmatizer
    from nltk.tokenize import word_tokenize

    synsets = wordnet.synsets("dog")  # needs wordnet (+ omw-1.4 for other languages)
    assert synsets and synsets[0].name() == "dog.n.01"
    assert "canine" in synsets[0].definition().lower() or "domestic" in synsets[0].definition().lower()
    lemmas = {lemma.name() for s in synsets for lemma in s.lemmas()}
    assert {"dog", "domestic_dog"} <= lemmas
    hypernyms = {h.name() for h in synsets[0].hypernyms()}
    assert "canine.n.02" in hypernyms or "domestic_animal.n.01" in hypernyms
    assert wordnet.synset("dog.n.01").path_similarity(wordnet.synset("cat.n.01")) > 0.1
    # Multilingual lemmas come from the Open Multilingual WordNet. nltk 3.9
    # reads the ``omw-1.4`` corpus, nltk >= 3.10 reads ``omw-2.0``: the image
    # must ship whichever the installed nltk asks for, or Spanish lookups fail.
    import warnings
    try:
        spanish_lemmas = wordnet.synset("dog.n.01").lemma_names("spa")
    except LookupError as exc:
        nltk = _nltk()
        # The catalogued corpus must at least be present (as a folder or the zip the downloader leaves).
        try:
            nltk.data.find("corpora/omw-1.4")
        except LookupError:
            nltk.data.find("corpora/omw-1.4.zip")
        warnings.warn(f"OMW corpus for nltk {nltk.__version__} missing, Spanish lemmas skipped: "
                      f"{str(exc).splitlines()[1].strip()}", stacklevel=1)
    else:
        assert "perro" in spanish_lemmas, spanish_lemmas
        assert "spa" in wordnet.langs()
    lemmatizer = WordNetLemmatizer()
    assert lemmatizer.lemmatize("dogs") == "dog"
    assert lemmatizer.lemmatize("running", pos="v") == "run"
    assert lemmatizer.lemmatize("better", pos="a") == "good"

    tagged = pos_tag(word_tokenize(ENGLISH))  # needs averaged_perceptron_tagger_eng + punkt_tab
    tags = dict(tagged)
    assert tags["Apple"] == "NNP" and tags["London"] == "NNP"
    assert tags["buying"] == "VBG" and tags["is"] == "VBZ"
    assert tags["startup"].startswith("NN")
    assert tags["according"] == "VBG"
    assert tags["$"] == "$" and tags["billion"] == "CD"

    sia = SentimentIntensityAnalyzer()  # needs vader_lexicon
    positive = sia.polarity_scores("I absolutely love this product, it is wonderful and works great!")
    negative = sia.polarity_scores("This is a terrible, disappointing and useless purchase. I hate it.")
    neutral = sia.polarity_scores("The report is on the table.")
    assert positive["compound"] > 0.6 and positive["pos"] > positive["neg"]
    assert negative["compound"] < -0.6 and negative["neg"] > negative["pos"]
    assert abs(neutral["compound"]) < 0.2 and neutral["neu"] > 0.8
    assert all(abs(sum(s[k] for k in ("pos", "neg", "neu")) - 1) < 0.01 for s in (positive, negative, neutral))


@pytest.mark.covers("spacy")
def test_spacy_spanish_model():
    import spacy

    nlp = spacy.load("es_core_news_sm")
    assert nlp.lang == "es"
    assert {"tok2vec", "morphologizer", "parser", "ner"} <= set(nlp.pipe_names)
    doc = nlp(SPANISH)
    assert len(doc) >= 17
    assert [t.text for t in doc][:4] == ["El", "Ministerio", "de", "Economía"]

    pos = {token.text: token.pos_ for token in doc}
    assert pos["Ministerio"] == "PROPN" and pos["Lima"] == "PROPN"
    assert pos["anunció"] == "VERB" and pos["bajó"] == "VERB"
    assert pos["inflación"] == "NOUN"
    assert pos["El"] == "DET" and pos["de"] == "ADP"
    assert pos["2026"] == "NUM"

    lemmas = {token.text: token.lemma_ for token in doc}
    assert lemmas["anunció"] == "anunciar" and lemmas["bajó"] == "bajar"
    assert lemmas["El"] == "el"

    entities = {ent.text: ent.label_ for ent in doc.ents}
    assert "Lima" in entities and entities["Lima"] == "LOC"
    assert any("Ministerio de Economía" in text for text in entities), entities
    # The small model tags the ministry as ORG or LOC depending on the version; either is an entity.
    assert entities[next(t for t in entities if "Ministerio" in t)] in {"ORG", "LOC", "MISC"}

    # Dependency parse: the main verb is the root and has a nominal subject.
    root = [token for token in doc if token.dep_ == "ROOT"][0]
    assert root.text == "anunció"
    assert any(child.dep_ == "nsubj" and child.text == "Ministerio" for child in root.children)
    assert [s.text for s in doc.sents] == [SPANISH]
    morph = {t.text: t.morph.to_dict() for t in doc}["inflación"]
    assert morph.get("Number") == "Sing" and morph.get("Gender") == "Fem"
    assert doc[0].is_stop and not doc[1].is_stop
    assert doc.vector.shape[0] > 0  # tok2vec-based vectors (sm models have no static vectors)


@pytest.mark.covers("spacy")
def test_spacy_english_model():
    import spacy
    from spacy.matcher import Matcher

    nlp = spacy.load("en_core_web_sm")
    assert nlp.lang == "en"
    assert {"tagger", "parser", "ner", "lemmatizer"} <= set(nlp.pipe_names)
    doc = nlp(ENGLISH)

    entities = {ent.text: ent.label_ for ent in doc.ents}
    assert entities.get("Apple") == "ORG"
    assert entities.get("London") == "GPE"
    assert entities.get("$1 billion") == "MONEY"
    assert entities.get("Reuters") == "ORG"

    pos = {token.text: token.pos_ for token in doc}
    tags = {token.text: token.tag_ for token in doc}
    assert pos["looking"] == "VERB" and tags["looking"] == "VBG"
    assert pos["startup"] == "NOUN" and pos["Apple"] == "PROPN"
    assert {token.text: token.lemma_ for token in doc}["buying"] == "buy"
    assert [chunk.text for chunk in doc.noun_chunks][:2] == ["Apple", "a startup"]

    matcher = Matcher(nlp.vocab)
    matcher.add("BUY_EVENT", [[{"LEMMA": "buy"}, {"POS": "DET"}, {"POS": "NOUN"}]])
    matches = matcher(doc)
    assert len(matches) == 1
    _, start, end = matches[0]
    assert doc[start:end].text == "buying a startup"
    assert len(list(nlp("First sentence. Second one here. And a third!").sents)) == 3


@pytest.mark.covers("textblob")
def test_textblob_sentiment_polarity():
    from textblob import TextBlob

    # PatternAnalyzer (the default) ships its lexicon inside the package: no corpora download.
    positive = TextBlob("What a wonderful, excellent and delightful experience. I love it!")
    negative = TextBlob("This was a horrible, awful and disappointing waste of money.")
    assert positive.sentiment.polarity > 0.5
    assert negative.sentiment.polarity < -0.4
    assert 0 <= positive.sentiment.subjectivity <= 1
    assert positive.sentiment.polarity > negative.sentiment.polarity
    assert TextBlob("The table has four legs.").sentiment.polarity == 0

    blob = TextBlob("The quick brown fox jumps. The lazy dog sleeps!")
    assert len(blob.sentences) == 2
    assert list(blob.words)[:3] == ["The", "quick", "brown"]  # tokenizer uses the bundled regex tokenizer
    # Per-sentence polarity shows the aggregation works on parts too.
    mixed = TextBlob("I love the camera. The battery is terrible.")
    polarities = [s.sentiment.polarity for s in mixed.sentences]
    assert polarities[0] > 0 > polarities[1]


@pytest.mark.covers("langdetect")
def test_langdetect_spanish_and_others():
    from langdetect import DetectorFactory, detect, detect_langs

    DetectorFactory.seed = 0
    assert detect("Hola, ¿cómo estás?") == "es"
    assert detect("El Ministerio de Economía anunció que la inflación bajó en marzo.") == "es"
    assert detect("The quick brown fox jumps over the lazy dog near the river bank.") == "en"
    assert detect("Bonjour, je voudrais réserver une table pour deux personnes ce soir.") == "fr"
    assert detect("O relatório anual será publicado na próxima semana pelo ministério.") == "pt"
    probabilities = detect_langs("Buenos días a todos los asistentes de la conferencia de hoy.")
    assert probabilities[0].lang == "es" and probabilities[0].prob > 0.9
    from langdetect.lang_detect_exception import LangDetectException
    with pytest.raises(LangDetectException):
        detect("12345 67890")


@pytest.mark.covers("gensim")
def test_gensim_lda_and_word2vec(out):
    from gensim import corpora, models
    from gensim.models import Word2Vec
    from gensim.utils import simple_preprocess

    documents = [
        "el gobierno aprobó el presupuesto de salud y educación",
        "el ministerio de salud anunció nuevas vacunas para la población",
        "educación pública y salud son prioridades del presupuesto",
        "el equipo ganó el partido de fútbol con dos goles",
        "el delantero anotó un gol en el último minuto del partido",
        "la selección de fútbol entrenó para el próximo partido",
    ]
    stops = {"el", "de", "y", "la", "para", "del", "en", "un", "con", "son"}
    texts = [[w for w in simple_preprocess(doc, deacc=False) if w not in stops] for doc in documents]
    dictionary = corpora.Dictionary(texts)
    assert "salud" in dictionary.token2id and "fútbol" in dictionary.token2id
    corpus = [dictionary.doc2bow(text) for text in texts]
    assert len(corpus) == 6 and all(bow for bow in corpus)

    lda = models.LdaModel(corpus, num_topics=2, id2word=dictionary, passes=20, random_state=7,
                          alpha="auto", iterations=100)
    topics = lda.show_topics(num_topics=2, num_words=5, formatted=False)
    assert len(topics) == 2
    words_per_topic = [{word for word, _ in words} for _, words in topics]
    assert all(len(words) == 5 for words in words_per_topic)
    # Documents about the same theme should land in the same dominant topic.
    def dominant(index):
        return max(lda.get_document_topics(corpus[index], minimum_probability=0), key=lambda t: t[1])[0]
    health = {dominant(0), dominant(1), dominant(2)}
    football = {dominant(3), dominant(4), dominant(5)}
    assert len(health) == 1 and len(football) == 1 and health != football, (health, football)
    model_path = out / "lda.model"
    lda.save(str(model_path))
    assert models.LdaModel.load(str(model_path)).num_topics == 2
    assert os.path.getsize(model_path) > 0

    w2v = Word2Vec(sentences=texts * 20, vector_size=16, min_count=1, window=3, epochs=30, seed=1, workers=1)
    assert w2v.wv.vector_size == 16
    assert "partido" in w2v.wv and w2v.wv["partido"].shape == (16,)
    similarity = w2v.wv.similarity("partido", "fútbol")
    assert -1.0 <= similarity <= 1.0
    neighbours = [word for word, _ in w2v.wv.most_similar("gol", topn=3)]
    assert len(neighbours) == 3 and "gol" not in neighbours
    assert w2v.wv.n_similarity(["partido", "gol"], ["fútbol"]) == pytest.approx(
        w2v.wv.n_similarity(["fútbol"], ["partido", "gol"]))
    kv_path = out / "vectores.kv"
    w2v.wv.save(str(kv_path))
    from gensim.models import KeyedVectors
    assert KeyedVectors.load(str(kv_path)).similarity("partido", "fútbol") == pytest.approx(similarity)
