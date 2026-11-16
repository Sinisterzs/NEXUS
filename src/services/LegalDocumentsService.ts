export type LegalDocumentType = 'terms_of_use' | 'privacy_policy';
export type LegalRecordType = 'acceptance' | 'acknowledgement';

export interface LegalDocumentDto {
  id: string;
  doc_type: LegalDocumentType;
  version: string;
  content_hash: string;
  published_at: string | null;
  effective_at: string | null;
  content_markdown: string | null;
  official_url: string | null;
}

export interface CurrentLegalDocumentsResponse {
  documents: LegalDocumentDto[];
  missing_required_types: string[];
  complete: boolean;
}

export interface AcceptLegalDocumentRequest {
  doc_type: LegalDocumentType;
  version: string;
  content_hash: string;
  record_type: LegalRecordType;
  flow_origin: 'regularization' | 'register' | 'google_oauth' | 'version_update';
  app_version?: string;
}

export interface AcceptLegalDocumentResponse {
  id: string;
  doc_type: LegalDocumentType;
  doc_version: string;
  doc_hash: string;
  record_type: LegalRecordType;
  recorded_at: string;
  flow_origin: string;
  app_version?: string | null;
}

export type DocumentComplianceStatus = 'accepted' | 'pending' | 'outdated' | 'unavailable';

export interface DocumentStatusDto {
  doc_type: LegalDocumentType;
  status: DocumentComplianceStatus;
  current_version: string | null;
  current_hash: string | null;
  accepted_version: string | null;
}

export interface LegalStatusResponse {
  age_confirmed: boolean;
  terms_of_use: DocumentStatusDto;
  privacy_policy: DocumentStatusDto;
  ready: boolean;
}

export class LegalApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LegalApiError';
    this.status = status;
    this.code = code;
  }
}

function isValidDocumentDto(item: unknown): item is LegalDocumentDto {
  if (!item || typeof item !== 'object') return false;
  const doc = item as Record<string, unknown>;
  return (
    typeof doc.id === 'string' &&
    (doc.doc_type === 'terms_of_use' || doc.doc_type === 'privacy_policy') &&
    typeof doc.version === 'string' &&
    doc.version.length > 0 &&
    typeof doc.content_hash === 'string' &&
    doc.content_hash.length === 64
  );
}

export function isSafeExternalUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export class LegalDocumentsService {
  private inflightCurrent = new Map<string, Promise<CurrentLegalDocumentsResponse>>();
  private inflightAccept = new Map<string, Promise<AcceptLegalDocumentResponse>>();
  private inflightStatus = new Map<string, Promise<LegalStatusResponse>>();

  async fetchCurrentDocuments(
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<CurrentLegalDocumentsResponse> {
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    const existing = this.inflightCurrent.get(normalizedBase);
    if (existing && !signal) {
      return existing;
    }

    const promise = (async () => {
      let response: Response;
      try {
        response = await fetch(`${normalizedBase}/v1/legal/current`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal,
        });
      } catch {
        throw new LegalApiError(0, 'NETWORK_ERROR', 'Falha de conexão ao consultar documentos legais.');
      }

      if (!response.ok) {
        throw new LegalApiError(
          response.status,
          'LEGAL_FETCH_FAILED',
          'Não foi possível carregar os documentos legais vigentes.',
        );
      }

      const data = (await response.json()) as Partial<CurrentLegalDocumentsResponse>;
      if (!data || !Array.isArray(data.documents) || !Array.isArray(data.missing_required_types)) {
        throw new LegalApiError(500, 'INVALID_RESPONSE', 'Resposta inválida do servidor.');
      }

      const documents = data.documents.filter(isValidDocumentDto);
      return {
        documents,
        missing_required_types: data.missing_required_types.filter(
          (v): v is string => typeof v === 'string',
        ),
        complete: Boolean(data.complete),
      };
    })();

    if (!signal) {
      this.inflightCurrent.set(normalizedBase, promise);
    }

    try {
      return await promise;
    } finally {
      if (!signal) {
        this.inflightCurrent.delete(normalizedBase);
      }
    }
  }

  async acceptDocument(
    baseUrl: string,
    sessionToken: string,
    payload: AcceptLegalDocumentRequest,
    signal?: AbortSignal,
  ): Promise<AcceptLegalDocumentResponse> {
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    const key = `${normalizedBase}:${payload.doc_type}:${payload.version}:${payload.content_hash}`;
    const existing = this.inflightAccept.get(key);
    if (existing && !signal) {
      return existing;
    }

    const promise = (async () => {
      let response: Response;
      try {
        response = await fetch(`${normalizedBase}/v1/legal/accept`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify(payload),
          signal,
        });
      } catch {
        throw new LegalApiError(0, 'NETWORK_ERROR', 'Falha de conexão ao registrar aceite.');
      }

      if (response.status === 401) {
        throw new LegalApiError(401, 'AUTH_REQUIRED', 'Sessão expirada ou inválida.');
      }

      if (!response.ok) {
        let code = 'LEGAL_ACCEPT_FAILED';
        let message = 'Não foi possível registrar o aceite.';
        try {
          const errBody = (await response.json()) as { code?: string; message?: string };
          if (errBody.code) code = errBody.code;
          if (errBody.message) message = errBody.message;
        } catch {
          // ignore invalid error body
        }
        throw new LegalApiError(response.status, code, message);
      }

      return (await response.json()) as AcceptLegalDocumentResponse;
    })();

    if (!signal) {
      this.inflightAccept.set(key, promise);
    }

    try {
      return await promise;
    } finally {
      if (!signal) {
        this.inflightAccept.delete(key);
      }
    }
  }

  async fetchLegalStatus(
    baseUrl: string,
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<LegalStatusResponse> {
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    const key = `${normalizedBase}:${sessionToken.slice(0, 8)}`;
    const existing = this.inflightStatus.get(key);
    if (existing && !signal) {
      return existing;
    }

    const promise = (async () => {
      let response: Response;
      try {
        response = await fetch(`${normalizedBase}/v1/legal/status`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          cache: 'no-store',
          signal,
        });
      } catch {
        throw new LegalApiError(0, 'NETWORK_ERROR', 'Falha de conexão ao consultar status legal.');
      }

      if (response.status === 401) {
        throw new LegalApiError(401, 'AUTH_REQUIRED', 'Sessão expirada ou inválida.');
      }

      if (!response.ok) {
        throw new LegalApiError(
          response.status,
          'LEGAL_STATUS_FAILED',
          'Não foi possível consultar o status legal.',
        );
      }

      const data = (await response.json()) as Partial<LegalStatusResponse>;
      if (
        !data ||
        typeof data.age_confirmed !== 'boolean' ||
        typeof data.ready !== 'boolean' ||
        !data.terms_of_use ||
        !data.privacy_policy
      ) {
        throw new LegalApiError(500, 'INVALID_RESPONSE', 'Resposta inválida do servidor.');
      }

      return data as LegalStatusResponse;
    })();

    if (!signal) {
      this.inflightStatus.set(key, promise);
    }

    try {
      return await promise;
    } finally {
      if (!signal) {
        this.inflightStatus.delete(key);
      }
    }
  }
}

export const legalDocumentsService = new LegalDocumentsService();
