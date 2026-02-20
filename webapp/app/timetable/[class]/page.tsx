import timetableData from '@/data/timetable.json';
import TimetableClient from './timetable-client';

export async function generateStaticParams() {
  return Object.keys(timetableData).map(className => ({
    class: className,
  }));
}

export default function TimetablePage() {
  return <TimetableClient />;
}

