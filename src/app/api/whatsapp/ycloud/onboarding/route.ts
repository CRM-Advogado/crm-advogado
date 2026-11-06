import { handleYCloudOnboarding } from '@/lib/whatsapp/ycloud-onboarding-route';

export const runtime = 'nodejs';
export async function GET() {
  return handleYCloudOnboarding('status');
}
export async function POST(request: Request) {
  return handleYCloudOnboarding('reserve', request);
}
