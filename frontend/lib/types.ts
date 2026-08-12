export interface SeoAuditResult {
  listing_id: number;
  quality_score: number;
  score_tier: string;
  score_breakdown: Record<string, number>;
  issues: string[];
  suggestions: {
    title: string;
    description: string;
    meta_title: string;
    meta_description: string;
    tags: string[];
  };
  claude_used: boolean;
}

export interface SeoFields {
  title?: string;
  description?: string;
  meta_title?: string;
  meta_description?: string;
  tags?: string[];
}
