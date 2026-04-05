// iLink API types

export interface QrCodeResponse {
  ret: number;
  qrcode: string;           // uuid for polling
  qrcode_img_content: string; // full QR URL for scanning
}

export interface QrCodeStatusResponse {
  ret?: number;
  status?: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  [key: string]: unknown;
}

export interface AuthInfo {
  bot_token: string;
  ilink_bot_id: string;
  saved_at: string;
}

export interface TextItem {
  text: string;
}

export interface ImageMedia {
  aes_key?: string;
  cdn_url?: string;
  encrypt_query_param?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

export interface ImageItem {
  media?: ImageMedia;
}

export interface VoiceMedia {
  aes_key?: string;
  cdn_url?: string;
  full_url?: string;
  encrypt_query_param?: string;
  file_size?: number;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number; // voice duration in ms
  text?: string; // WeChat built-in transcription
}

export interface VoiceItem {
  media?: VoiceMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string; // WeChat built-in transcription
}

export interface MessageItem {
  type: number; // 1=text, 2=image, 3=voice
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
}

export interface IncomingMessage {
  seq: number;
  message_id: number;
  from_user_id: string;
  to_user_id: string;
  create_time_ms: number;
  session_id: string;
  message_type: number; // 1=USER, 2=BOT
  message_state: number; // 0=NEW
  context_token: string;
  item_list: MessageItem[];
}

export interface GetUpdatesRequest {
  get_updates_buf: string;
  base_info: {
    channel_version: string;
  };
}

export interface GetUpdatesResponse {
  ret: number;
  msgs: IncomingMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms: number;
}

export interface SendMessageRequest {
  msg: {
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    message_type: number;
    message_state: number;
    context_token: string;
    item_list: MessageItem[];
  };
}

export interface SendTypingRequest {
  to_user_id: string;
  status: number; // 1=typing, 2=cancel
  context_token: string;
}

export interface GetConfigResponse {
  typing_ticket?: string;
  [key: string]: unknown;
}
