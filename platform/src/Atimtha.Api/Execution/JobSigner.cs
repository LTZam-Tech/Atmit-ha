using System.Security.Cryptography;
using System.Text;

namespace Atimtha.Api.Execution;

/// <summary>
/// Signs execution packages (backlog §10/§13 "signed execution packages"): every job an agent claims carries an
/// ES256 signature (ECDSA P-256, SHA-256, IEEE P1363 r||s) over the exact response bytes, in the header
/// <c>X-Atimtha-Signature: &lt;keyId&gt;.&lt;base64&gt;</c>. Agents verify it with the public key from
/// <c>/api/agent/v1/signing-key</c> (or a key pinned on the agent) before they run anything.
/// The key is <c>Jobs:SigningKey</c> (PKCS#8 PEM); outside Development it is required (StartupChecks).
/// </summary>
public sealed class JobSigner : IDisposable
{
    public const string Header = "X-Atimtha-Signature";
    private readonly ECDsa key;

    public string KeyId { get; }
    public string PublicKeyPem { get; }
    public bool Ephemeral { get; }

    public JobSigner(IConfiguration configuration, ILogger<JobSigner> logger)
    {
        key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var pem = configuration["Jobs:SigningKey"];
        if (!string.IsNullOrWhiteSpace(pem))
        {
            key.ImportFromPem(pem.Replace("\\n", "\n"));
            if (key.KeySize != 256) throw new InvalidOperationException("Jobs:SigningKey must be an ECDSA P-256 private key (PEM).");
        }
        else
        {
            // a fresh key per start: fine for development, useless for agents that pin a key
            Ephemeral = true;
            logger.LogWarning("Jobs:SigningKey is not set: jobs are signed with a temporary key that changes on every start.");
        }
        var spki = key.ExportSubjectPublicKeyInfo();
        KeyId = Convert.ToHexStringLower(SHA256.HashData(spki))[..16];
        PublicKeyPem = PemEncoding.WriteString("PUBLIC KEY", spki);
    }

    public string Sign(string body) =>
        $"{KeyId}.{Convert.ToBase64String(key.SignData(Encoding.UTF8.GetBytes(body), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))}";

    public void Dispose() => key.Dispose();
}
