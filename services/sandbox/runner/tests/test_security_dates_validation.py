"""Areas "security", "dates" and "validation".

Cryptography round-trips (encrypt -> decrypt, sign -> verify, hash -> known
digest), GnuPG through the library and the CLI, calendar arithmetic with real
holidays, and validators checked against both a known-good and a known-bad
value so a library that accepts everything cannot pass.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import os
import stat
import subprocess
from pathlib import Path

import pytest


# =========================================================================== security
@pytest.mark.covers("cryptography")
def test_cryptography_fernet_rsa_and_self_signed_certificate(out, check):
    from cryptography import x509
    from cryptography.fernet import Fernet, InvalidToken
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from cryptography.x509.oid import NameOID

    # Symmetric: Fernet.
    key = Fernet.generate_key()
    box = Fernet(key)
    token = box.encrypt(b"informe confidencial")
    assert box.decrypt(token) == b"informe confidencial"
    with pytest.raises(InvalidToken):
        Fernet(Fernet.generate_key()).decrypt(token)

    # Asymmetric: RSA sign / verify.
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    message = b"acta firmada"
    signature = private.sign(message, padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                                                  salt_length=padding.PSS.MAX_LENGTH), hashes.SHA256())
    private.public_key().verify(signature, message, padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                                                                 salt_length=padding.PSS.MAX_LENGTH),
                                hashes.SHA256())
    from cryptography.exceptions import InvalidSignature
    with pytest.raises(InvalidSignature):
        private.public_key().verify(signature, b"otro texto", padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.MAX_LENGTH), hashes.SHA256())

    # X.509: a self-signed certificate written as PEM and loaded back.
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "sira.example.com"),
                      x509.NameAttribute(NameOID.COUNTRY_NAME, "PE")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(private.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now).not_valid_after(now + dt.timedelta(days=30))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("sira.example.com")]), critical=False)
            .sign(private, hashes.SHA256()))
    pem = out / "cert.pem"
    pem.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_pem = out / "key.pem"
    key_pem.write_bytes(private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption()))
    check.nonempty(pem, 500)
    assert pem.read_bytes().startswith(b"-----BEGIN CERTIFICATE-----")
    loaded = x509.load_pem_x509_certificate(pem.read_bytes())
    assert loaded.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value == "sira.example.com"
    assert loaded.issuer == loaded.subject
    san = loaded.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert san.get_values_for_type(x509.DNSName) == ["sira.example.com"]
    reloaded_key = serialization.load_pem_private_key(key_pem.read_bytes(), password=None)
    assert reloaded_key.public_key().public_numbers() == private.public_key().public_numbers()


@pytest.mark.covers("Crypto")
def test_pycryptodome_aes_gcm_and_sha3(out):
    from Crypto.Cipher import AES
    from Crypto.Hash import SHA3_256
    from Crypto.Random import get_random_bytes
    key = get_random_bytes(32)
    cipher = AES.new(key, AES.MODE_GCM)
    header = b"cabecera"
    cipher.update(header)
    ciphertext, tag = cipher.encrypt_and_digest(b"datos sensibles 1234")
    assert ciphertext != b"datos sensibles 1234" and len(tag) == 16
    blob = out / "secreto.bin"
    blob.write_bytes(cipher.nonce + tag + ciphertext)
    raw = blob.read_bytes()
    nonce, tag2, body = raw[:16], raw[16:32], raw[32:]
    dec = AES.new(key, AES.MODE_GCM, nonce=nonce)
    dec.update(header)
    assert dec.decrypt_and_verify(body, tag2) == b"datos sensibles 1234"
    tampered = AES.new(key, AES.MODE_GCM, nonce=nonce)
    tampered.update(header)
    with pytest.raises(ValueError):
        tampered.decrypt_and_verify(bytes([body[0] ^ 1]) + body[1:], tag2)
    digest = SHA3_256.new(b"hola").hexdigest()
    assert digest == hashlib.sha3_256(b"hola").hexdigest()
    assert len(digest) == 64


@pytest.mark.covers("bcrypt")
def test_bcrypt_hashes_and_checks_passwords():
    import bcrypt
    password = "contraseña-segura-2026".encode("utf-8")
    hashed = bcrypt.hashpw(password, bcrypt.gensalt(rounds=5))
    assert hashed.startswith(b"$2b$05$")
    assert bcrypt.checkpw(password, hashed)
    assert not bcrypt.checkpw(b"otra", hashed)
    # Two hashes of the same password differ (random salt) but both verify.
    again = bcrypt.hashpw(password, bcrypt.gensalt(rounds=5))
    assert again != hashed and bcrypt.checkpw(password, again)
    assert len(bcrypt.kdf(password=password, salt=b"salsalsalsalsals", desired_key_bytes=32, rounds=50)) == 32


@pytest.mark.covers("nacl")
def test_pynacl_secretbox_and_signing():
    import nacl.encoding
    import nacl.exceptions
    import nacl.hash
    import nacl.secret
    import nacl.signing
    import nacl.utils
    key = nacl.utils.random(nacl.secret.SecretBox.KEY_SIZE)
    box = nacl.secret.SecretBox(key)
    encrypted = box.encrypt(b"mensaje privado")
    assert len(encrypted) == len(b"mensaje privado") + box.NONCE_SIZE + box.MACBYTES
    assert box.decrypt(encrypted) == b"mensaje privado"
    with pytest.raises(nacl.exceptions.CryptoError):
        nacl.secret.SecretBox(nacl.utils.random(32)).decrypt(encrypted)
    signing_key = nacl.signing.SigningKey.generate()
    signed = signing_key.sign(b"documento")
    verify_key = nacl.signing.VerifyKey(signing_key.verify_key.encode(encoder=nacl.encoding.HexEncoder),
                                        encoder=nacl.encoding.HexEncoder)
    assert verify_key.verify(signed) == b"documento"
    with pytest.raises(nacl.exceptions.BadSignatureError):
        verify_key.verify(b"documentX", signed.signature)
    assert len(nacl.hash.blake2b(b"hola", encoder=nacl.encoding.RawEncoder)) == 32  # 256-bit default


@pytest.mark.covers("pyotp")
def test_pyotp_totp_and_hotp_with_fixed_times():
    import pyotp
    secret = pyotp.random_base32()
    assert len(secret) == 32
    totp = pyotp.TOTP(secret)
    code = totp.at(0)
    assert len(code) == 6 and code.isdigit()
    assert totp.verify(code, for_time=0)
    assert totp.verify(code, for_time=29)  # same 30-s window
    assert not totp.verify(code, for_time=90)  # three windows later
    assert totp.at(0) != totp.at(60) or totp.at(0) != totp.at(120)
    hotp = pyotp.HOTP(secret)
    assert hotp.verify(hotp.at(5), 5) and not hotp.verify(hotp.at(5), 6)
    # The reference vector from RFC 6238 (SHA1, 8 digits, time 59 -> 94287082).
    ref = pyotp.TOTP(pyotp.utils.strings_to_base32("12345678901234567890") if hasattr(pyotp, "utils") and
                     hasattr(pyotp.utils, "strings_to_base32") else "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
                     digits=8)
    assert ref.at(59) == "94287082"
    uri = totp.provisioning_uri(name="ana@example.com", issuer_name="SiraGPT")
    assert uri.startswith("otpauth://totp/SiraGPT:ana%40example.com?") and secret in uri


def _gnupg_home(out) -> Path:
    home = out / "gnupg"
    home.mkdir()
    home.chmod(stat.S_IRWXU)
    return home


def _kill_agent(home):
    subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "gpg-agent"], capture_output=True,
                   check=False, timeout=20)


@pytest.mark.covers("gnupg", "gpg")
def test_python_gnupg_generates_key_encrypts_and_decrypts_file(out):
    import gnupg
    home = _gnupg_home(out)
    gpg = gnupg.GPG(gnupghome=str(home))
    gpg.encoding = "utf-8"
    try:
        params = gpg.gen_key_input(key_type="RSA", key_length=2048, name_real="Sira Prueba",
                                   name_email="sira@example.com", no_protection=True, expire_date=0)
        assert "%no-protection" in params
        key = gpg.gen_key(params)
        assert key.fingerprint, f"key generation failed: {key.stderr[-600:]}"
        keys = gpg.list_keys()
        assert any(k["fingerprint"] == key.fingerprint for k in keys)
        assert any("sira@example.com" in uid for k in keys for uid in k["uids"])
        plain = out / "acta.txt"
        plain.write_text("Acta de reunión: aprobado por unanimidad.\n", encoding="utf-8")
        encrypted = out / "acta.txt.gpg"
        with plain.open("rb") as handle:
            result = gpg.encrypt_file(handle, recipients=[key.fingerprint], output=str(encrypted),
                                      always_trust=True, armor=False)
        assert result.ok, result.status + " " + result.stderr[-400:]
        assert encrypted.stat().st_size > 200
        assert b"aprobado" not in encrypted.read_bytes()
        decrypted = out / "acta.dec.txt"
        with encrypted.open("rb") as handle:
            result = gpg.decrypt_file(handle, output=str(decrypted))
        assert result.ok, result.status + " " + result.stderr[-400:]
        assert decrypted.read_text(encoding="utf-8") == plain.read_text(encoding="utf-8")
        # Detached signature, verified.
        with plain.open("rb") as handle:
            sig = gpg.sign_file(handle, keyid=key.fingerprint, detach=True, output=str(out / "acta.sig"))
        assert sig.status in ("signature created", "begin signing") or bool(sig.data)
        with (out / "acta.sig").open("rb") as handle:
            verified = gpg.verify_file(handle, str(plain))
        assert verified.valid and verified.fingerprint == key.fingerprint
        exported = gpg.export_keys(key.fingerprint)
        assert exported.startswith("-----BEGIN PGP PUBLIC KEY BLOCK-----")
    finally:
        _kill_agent(home)


@pytest.mark.covers("gpg")
def test_gpg_cli_symmetric_encryption_round_trip(out, check):
    home = _gnupg_home(out)
    plain = out / "nomina.csv"
    plain.write_text("nombre,sueldo\nAna,3500\n", encoding="utf-8")
    encrypted = out / "nomina.csv.gpg"
    common = ["gpg", "--homedir", str(home), "--batch", "--yes", "--pinentry-mode", "loopback",
              "--passphrase", "clave-de-prueba"]
    try:
        check.run([*common, "--symmetric", "--cipher-algo", "AES256", "-o", str(encrypted), str(plain)], timeout=60)
        check.nonempty(encrypted, 60)
        assert b"Ana,3500" not in encrypted.read_bytes()
        decrypted = out / "nomina.dec.csv"
        check.run([*common, "-o", str(decrypted), "--decrypt", str(encrypted)], timeout=60)
        assert decrypted.read_text(encoding="utf-8") == plain.read_text(encoding="utf-8")
        bad = subprocess.run(["gpg", "--homedir", str(home), "--batch", "--yes", "--pinentry-mode", "loopback",
                              "--passphrase", "incorrecta", "-o", str(out / "x.csv"), "--decrypt", str(encrypted)],
                             capture_output=True, text=True, check=False, timeout=60)
        assert bad.returncode != 0
        version = check.run(["gpg", "--version"]).stdout
        assert version.startswith("gpg (GnuPG)")
    finally:
        _kill_agent(home)


# =========================================================================== dates
@pytest.mark.covers("dateutil")
def test_dateutil_parses_and_does_relative_arithmetic():
    from dateutil import parser, relativedelta, rrule, tz
    parsed = parser.parse("28 de julio de 2024 15:30", dayfirst=True, fuzzy=True,
                          parserinfo=_SpanishParserInfo())
    assert parsed == dt.datetime(2024, 7, 28, 15, 30)
    assert parser.isoparse("2024-07-28T15:30:00-05:00").utcoffset() == dt.timedelta(hours=-5)
    delta = relativedelta.relativedelta(dt.date(2026, 10, 19), dt.date(1990, 3, 1))
    assert (delta.years, delta.months, delta.days) == (36, 7, 18)
    end_of_month = dt.date(2024, 1, 31) + relativedelta.relativedelta(months=1)
    assert end_of_month == dt.date(2024, 2, 29)
    mondays = list(rrule.rrule(rrule.WEEKLY, byweekday=rrule.MO, dtstart=dt.datetime(2024, 7, 1), count=3))
    assert [d.day for d in mondays] == [1, 8, 15]
    lima = tz.gettz("America/Lima")
    assert dt.datetime(2024, 7, 28, 12, tzinfo=lima).utcoffset() == dt.timedelta(hours=-5)


class _SpanishParserInfo:
    """Built lazily so the module imports without dateutil installed."""

    def __new__(cls):
        from dateutil import parser

        class Info(parser.parserinfo):
            MONTHS = [("ene", "enero"), ("feb", "febrero"), ("mar", "marzo"), ("abr", "abril"),
                      ("may", "mayo"), ("jun", "junio"), ("jul", "julio"), ("ago", "agosto"),
                      ("sep", "septiembre"), ("oct", "octubre"), ("nov", "noviembre"), ("dic", "diciembre")]
            JUMP = parser.parserinfo.JUMP + ["de", "del"]

        return Info()


@pytest.mark.covers("pytz")
def test_pytz_localises_and_converts_across_dst():
    import pytz
    madrid = pytz.timezone("Europe/Madrid")
    lima = pytz.timezone("America/Lima")
    summer = madrid.localize(dt.datetime(2024, 7, 15, 12, 0))
    winter = madrid.localize(dt.datetime(2024, 1, 15, 12, 0))
    assert summer.utcoffset() == dt.timedelta(hours=2)
    assert winter.utcoffset() == dt.timedelta(hours=1)
    assert summer.astimezone(lima).hour == 5
    assert summer.astimezone(pytz.utc).isoformat() == "2024-07-15T10:00:00+00:00"
    with pytest.raises(pytz.exceptions.NonExistentTimeError):
        madrid.localize(dt.datetime(2024, 3, 31, 2, 30), is_dst=None)
    assert "America/Lima" in pytz.country_timezones["PE"]


@pytest.mark.covers("tzdata")
def test_tzdata_backs_zoneinfo():
    import zoneinfo

    import tzdata
    assert tzdata.IANA_VERSION >= "2024a"
    assert os.path.isdir(os.path.join(os.path.dirname(tzdata.__file__), "zoneinfo", "America"))
    # Force the pure-Python zoneinfo path onto the tzdata package, not /usr/share/zoneinfo.
    tzpath = (os.path.join(os.path.dirname(tzdata.__file__), "zoneinfo"),)
    zoneinfo.reset_tzpath(to=tzpath)
    try:
        zoneinfo.ZoneInfo.clear_cache()
        lima = zoneinfo.ZoneInfo("America/Lima")
        madrid = zoneinfo.ZoneInfo("Europe/Madrid")
        moment = dt.datetime(2024, 7, 15, 12, tzinfo=madrid)
        assert moment.astimezone(lima).hour == 5
        assert "America/Lima" in zoneinfo.available_timezones()
    finally:
        zoneinfo.reset_tzpath()
        zoneinfo.ZoneInfo.clear_cache()


@pytest.mark.covers("arrow")
def test_arrow_shifts_formats_and_humanises_in_spanish():
    import arrow
    start = arrow.get("2024-07-28T15:30:00-05:00")
    assert start.tzinfo.utcoffset(start.datetime) == dt.timedelta(hours=-5)
    assert start.to("UTC").hour == 20
    later = start.shift(weeks=2, hours=3)
    assert later.format("YYYY-MM-DD HH:mm") == "2024-08-11 18:30"
    assert later.humanize(start, locale="es") in ("en 2 semanas", "en 14 días")
    assert start.format("dddd D [de] MMMM [de] YYYY", locale="es") == "domingo 28 de julio de 2024"
    span = start.span("month")
    assert span[0].day == 1 and span[1].day == 31
    assert len(list(arrow.Arrow.range("day", start, start.shift(days=3)))) == 4


@pytest.mark.covers("pendulum")
def test_pendulum_durations_periods_and_business_days():
    import pendulum
    start = pendulum.datetime(2024, 7, 28, 15, 30, tz="America/Lima")
    end = pendulum.datetime(2024, 12, 25, 15, 30, tz="America/Lima")
    period = end - start
    assert period.in_days() == 150 and period.in_weeks() == 21
    assert (period.months, period.weeks, period.remaining_days) == (4, 3, 6)
    assert period.in_words(locale="es") == "4 meses 3 semanas 6 días"
    assert start.add(months=1).day == 28
    assert start.in_timezone("Europe/Madrid").hour == 22
    assert start.format("dddd D [de] MMMM", locale="es") == "domingo 28 de julio"
    assert start.day_of_week == pendulum.SUNDAY
    assert start.next(pendulum.MONDAY).to_date_string() == "2024-07-29"
    assert pendulum.duration(hours=90).in_words(locale="es") == "3 días 18 horas"
    assert pendulum.parse("2024-07-28T15:30:00-05:00") == start
    assert start.end_of("month").day == 31


@pytest.mark.covers("holidays")
def test_holidays_knows_peru_spain_and_mexico():
    import holidays
    pe = holidays.PE(years=2024)
    es = holidays.ES(years=2024)
    mx = holidays.MX(years=2024)
    assert dt.date(2024, 7, 28) in pe and "Independencia" in pe[dt.date(2024, 7, 28)]
    assert dt.date(2024, 10, 12) in es and "Nacional" in es[dt.date(2024, 10, 12)]
    assert dt.date(2024, 9, 16) in mx and "Independencia" in mx[dt.date(2024, 9, 16)]
    assert dt.date(2024, 7, 29) in pe  # second day of Fiestas Patrias
    assert dt.date(2024, 7, 30) not in pe
    assert dt.date(2024, 1, 1) in pe and dt.date(2024, 1, 1) in es and dt.date(2024, 1, 1) in mx
    assert "2024-12-25" in es  # string lookup
    assert len(pe) >= 12
    # Country + subdivision and financial markets are available too.
    assert dt.date(2024, 3, 19) in holidays.ES(subdiv="VC", years=2024)  # San José in Valencia
    assert dt.date(2024, 7, 4) in holidays.NYSE(years=2024)


@pytest.mark.covers("icalendar")
def test_icalendar_writes_recurring_event_and_reads_back(out, check):
    from icalendar import Calendar, Event, vRecur
    cal = Calendar()
    cal.add("prodid", "-//SiraGPT//Agenda//ES")
    cal.add("version", "2.0")
    event = Event()
    event.add("uid", "reunion-semanal@example.com")
    event.add("summary", "Reunión semanal de equipo")
    event.add("dtstart", dt.datetime(2024, 7, 29, 9, 0, tzinfo=dt.timezone.utc))
    event.add("dtend", dt.datetime(2024, 7, 29, 10, 0, tzinfo=dt.timezone.utc))
    event.add("rrule", vRecur(freq="WEEKLY", byday="MO", count=10))
    event.add("location", "Sala 3")
    cal.add_component(event)
    ics = out / "agenda.ics"
    ics.write_bytes(cal.to_ical())
    check.nonempty(ics, 150)
    text = ics.read_text(encoding="utf-8")
    assert "BEGIN:VCALENDAR" in text and "RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO" in text
    assert "SUMMARY:Reunión semanal de equipo" in text
    back = Calendar.from_ical(ics.read_bytes())
    events = list(back.walk("VEVENT"))
    assert len(events) == 1
    ev = events[0]
    assert str(ev["summary"]) == "Reunión semanal de equipo"
    assert ev.decoded("dtstart") == dt.datetime(2024, 7, 29, 9, 0, tzinfo=dt.timezone.utc)
    rule = ev["rrule"]
    assert rule["FREQ"] == ["WEEKLY"] and rule["COUNT"] == [10] and [str(d) for d in rule["BYDAY"]] == ["MO"]


@pytest.mark.covers("babel")
def test_babel_formats_currency_dates_and_numbers_for_spanish_locales():
    from babel.dates import format_date, format_datetime
    from babel.numbers import format_currency, format_decimal, parse_decimal
    nbsp = "\xa0"
    assert format_currency(1234567.5, "EUR", locale="es_ES") == f"1.234.567,50{nbsp}€"
    assert format_currency(1234567.5, "PEN", locale="es_PE") == f"S/{nbsp}1,234,567.50"
    assert format_currency(99.9, "MXN", locale="es_MX") == "$99.90"
    assert format_date(dt.date(2024, 7, 28), format="long", locale="es") == "28 de julio de 2024"
    assert format_date(dt.date(2024, 7, 28), format="full", locale="es_PE") == "domingo, 28 de julio de 2024"
    assert format_datetime(dt.datetime(2024, 7, 28, 15, 5), "d MMM y, HH:mm", locale="es") == "28 jul 2024, 15:05"
    assert format_decimal(12345.678, locale="es_ES") == "12.345,678"
    assert parse_decimal("1.234,5", locale="es_ES") == 1234.5
    assert format_decimal(12345.678, locale="en_US") == "12,345.678"


# =========================================================================== validation
@pytest.mark.covers("phonenumbers")
def test_phonenumbers_parses_formats_and_validates_peruvian_number():
    import phonenumbers
    from phonenumbers import PhoneNumberFormat, carrier, geocoder
    number = phonenumbers.parse("+51 987 654 321")
    assert phonenumbers.is_valid_number(number)
    assert phonenumbers.region_code_for_number(number) == "PE"
    assert phonenumbers.format_number(number, PhoneNumberFormat.E164) == "+51987654321"
    assert phonenumbers.format_number(number, PhoneNumberFormat.INTERNATIONAL) == "+51 987 654 321"
    assert phonenumbers.number_type(number) == phonenumbers.PhoneNumberType.MOBILE
    assert geocoder.description_for_number(number, "es") in ("Perú", "Peru")
    assert carrier.name_for_number(number, "es") != None  # noqa: E711 - may be empty, must not raise
    national = phonenumbers.parse("987 654 321", "PE")
    assert national == number
    bad = phonenumbers.parse("+51 12", "PE")
    assert not phonenumbers.is_valid_number(bad)
    with pytest.raises(phonenumbers.NumberParseException):
        phonenumbers.parse("hola", None)
    spain = phonenumbers.parse("+34 912 345 678")
    assert phonenumbers.is_valid_number(spain) and phonenumbers.region_code_for_number(spain) == "ES"


@pytest.mark.covers("email_validator")
def test_email_validator_normalises_and_rejects():
    from email_validator import EmailNotValidError, validate_email
    info = validate_email("Ana.Perez@Example.COM", check_deliverability=False)
    assert info.normalized == "Ana.Perez@example.com"
    assert info.domain == "example.com" and info.local_part == "Ana.Perez"
    for bad in ("sin-arroba.com", "ana@", "ana@@example.com", "ana@-example.com", "ana ana@example.com"):
        with pytest.raises(EmailNotValidError):
            validate_email(bad, check_deliverability=False)
    intl = validate_email("josé@ejemplo.pe", check_deliverability=False, allow_smtputf8=True)
    assert intl.smtputf8 is True


@pytest.mark.covers("stdnum")
def test_stdnum_validates_peruvian_ruc_and_spanish_nif():
    from stdnum import iban
    from stdnum.es import nif
    from stdnum.exceptions import InvalidChecksum, InvalidLength
    from stdnum.pe import ruc
    assert ruc.is_valid("20512333797")
    assert ruc.validate("20512333797") == "20512333797"
    assert not ruc.is_valid("20512333798")
    with pytest.raises(InvalidChecksum):
        ruc.validate("20512333798")
    with pytest.raises(InvalidLength):
        ruc.validate("2051233379")
    assert nif.is_valid("12345678Z") and not nif.is_valid("12345678A")
    assert nif.validate("12345678-z") == "12345678Z" and nif.compact("12345678-z") == "12345678Z"
    assert iban.is_valid("ES91 2100 0418 4502 0005 1332")
    assert iban.format("ES9121000418450200051332") == "ES91 2100 0418 4502 0005 1332"


@pytest.mark.covers("schwifty")
def test_schwifty_parses_iban_and_bic():
    from schwifty import BIC, IBAN
    from schwifty.exceptions import SchwiftyException
    iban = IBAN("DE89 3704 0044 0532 0130 00")
    assert iban.country_code == "DE"
    assert iban.bank_code == "37040044" and iban.account_code == "0532013000"
    assert iban.formatted == "DE89 3704 0044 0532 0130 00"
    assert iban.bic is not None and str(iban.bic) == "COBADEFFXXX"
    spanish = IBAN("ES91 2100 0418 4502 0005 1332")
    assert spanish.country_code == "ES" and spanish.checksum_digits == "91"
    with pytest.raises(SchwiftyException):
        IBAN("DE89 3704 0044 0532 0130 01")
    bic = BIC("COBADEFFXXX")
    assert bic.country_code == "DE" and bic.bank_code == "COBA" and bic.location_code == "FF"
    generated = IBAN.generate("DE", bank_code="37040044", account_code="532013000")
    assert str(generated) == "DE89370400440532013000"


@pytest.mark.covers("validators")
def test_validators_accepts_good_values_and_rejects_bad_ones():
    import validators
    assert validators.url("https://siragpt.com/agentes?id=1")
    assert not validators.url("no es una url")
    assert not validators.url("http://")
    assert validators.ipv4("192.168.1.10") and not validators.ipv4("300.1.1.1")
    assert validators.ipv6("2001:db8::1") and not validators.ipv6("2001:zz8::1")
    assert validators.uuid("123e4567-e89b-12d3-a456-426614174000") and not validators.uuid("123e4567")
    assert validators.email("ana@example.com") and not validators.email("ana@")
    assert validators.domain("siragpt.com") and not validators.domain("siragpt..com")
    assert validators.iban("DE89370400440532013000") and not validators.iban("DE89370400440532013001")
    failure = validators.url("nope")
    assert isinstance(failure, validators.ValidationError) and bool(failure) is False


@pytest.mark.covers("faker")
def test_faker_generates_seeded_spanish_data():
    from faker import Faker
    fake = Faker("es_ES")
    fake.seed_instance(2026)
    name = fake.name()
    address = fake.address()
    assert name.strip() and len(name.split()) >= 2
    assert "\n" in address and any(ch.isdigit() for ch in address)
    assert fake.postcode().isdigit() and len(fake.postcode()) == 5
    assert "@" in fake.email()
    # Seeding is deterministic: a second generator with the same seed repeats the data.
    again = Faker("es_ES")
    again.seed_instance(2026)
    assert again.name() == name and again.address() == address
    other = Faker("es_ES")
    other.seed_instance(1)
    assert other.name() != name
    peru = Faker("es_PE" if "es_PE" in _faker_locales() else "es_ES")
    assert peru.company().strip()
    rows = [fake.simple_profile() for _ in range(5)]
    assert {row["sex"] for row in rows} <= {"F", "M"} and all(row["username"] for row in rows)


def _faker_locales():
    from faker.config import AVAILABLE_LOCALES
    return set(AVAILABLE_LOCALES)
