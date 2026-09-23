from pydantic import BaseModel, Field


class Evidence(BaseModel):
    timestamp: str
    quote: str = Field(max_length=300)


class MemoryCandidate(BaseModel):
    category: str
    fact: str
    confidence: float = Field(ge=0, le=1)
    evidence: list[Evidence]


class PersonalityTrait(BaseModel):
    trait: str
    description: str
    confidence: float = Field(ge=0, le=1)
    evidence: list[Evidence]
    communication_implication: str


class ChunkAnalysis(BaseModel):
    memory_candidates: list[MemoryCandidate]
    personality_signals: list[PersonalityTrait]


class FinalAnalysis(BaseModel):
    target_speaker: str
    profile_summary: str
    long_term_memories: list[MemoryCandidate]
    personality_traits: list[PersonalityTrait]
    persona_prompt: str
    limitations: list[str]
