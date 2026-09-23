import PageHeading from '@/components/page-heading';
import AgentInspector from '@/components/agent-inspector';
import ProfileImporter from '@/components/profile-importer';

export default function ProfilesPage() {
  return (
    <main id="main-content" className="focused-page">
      <PageHeading eyebrow="让陪伴更熟悉" title="人物与记忆" description="从过往对话中整理性格与记忆，确认后用于你的影伴。" />
      <ProfileImporter />
      <AgentInspector />
    </main>
  );
}
