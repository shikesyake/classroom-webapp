import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const FORM_URL = process.env.FORM_URL || 'https://docs.google.com/forms/d/e/1FAIpQLScUd3YWWX57ZIZP1de41DH8YQKlFCJZjQAW3Vj0EpijXq8WMw/viewform';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './data';

interface ClassInfo {
  year: string; // "1", "2", "3"
  type: string; // "F" or "M"
}

interface Change {
  date: string; // "2026-02-18"
  classes: ClassInfo[]; // 複数クラスに対応
  periods: number[]; // 1-6の時数
  subject: string; // 変更後の科目
  description: string; // 元の説明
}

interface FormattedData {
  title: string;
  fetchedAt: string;
  changes: Change[];
  rawItems?: Array<{ title: string }>; // デバッグ用
  errors?: string[];
}

interface WebappChange {
  date: string;
  classYear: string;
  period: number;
  day: string;
  newSubject: string;
  description: string;
}

interface RawFormData {
  url: string;
  title: string;
  description: string;
  items: Array<{
    title: string;
    description?: string;
    required?: boolean;
    type?: string;
  }>;
  fetchedAt: string;
}

async function fetchFormData(): Promise<RawFormData> {
  try {
    console.log(`フォームを取得中: ${FORM_URL}`);
    
    const response = await axios.get(FORM_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    const $ = cheerio.load(response.data);
    
    // フォームタイトルを取得
    const title = $('div[role="heading"]').first().text().trim() || 
                  $('meta[property="og:title"]').attr('content') || 
                  'フォームタイトル不明';
    
    // フォーム説明を取得
    const description = $('div.freebirdFormviewerViewHeaderDescription').text().trim() || '';
    
    // 設問を取得
    const items: Array<{
      title: string;
      description?: string;
      required?: boolean;
      type?: string;
    }> = [];
    
    // 各設問のコンテナを探す
    $('div[role="listitem"]').each((index, element) => {
      const $element = $(element);
      
      // 設問タイトル
      const questionTitle = $element.find('div[role="heading"]').text().trim();
      
      if (questionTitle) {
        // 必須マークの有無
        const isRequired = $element.find('span.freebirdFormviewerComponentsQuestionBaseRequiredAsterisk').length > 0;
        
        // 設問タイプを推測
        let questionType = 'unknown';
        if ($element.find('input[type="text"]').length > 0) {
          questionType = 'text';
        } else if ($element.find('textarea').length > 0) {
          questionType = 'paragraph';
        } else if ($element.find('input[type="radio"]').length > 0) {
          questionType = 'radio';
        } else if ($element.find('input[type="checkbox"]').length > 0) {
          questionType = 'checkbox';
        } else if ($element.find('select').length > 0) {
          questionType = 'dropdown';
        }
        
        items.push({
          title: questionTitle,
          required: isRequired,
          type: questionType,
        });
      }
    });

    const formData: RawFormData = {
      url: FORM_URL,
      title: title,
      description: description,
      items: items,
      fetchedAt: new Date().toISOString(),
    };

    return formData;
  } catch (error: any) {
    console.error('フォームデータの取得に失敗しました:', error.message);
    throw error;
  }
}

// クラス情報をパース（1F → {year: "1", type: "F"}）
function parseClass(text: string): ClassInfo | null {
  const normalized = normalizeText(text);
  const match = normalized.match(/([123])[\/\s]?([FM])/i);
  if (match) {
    return {
      year: match[1],
      type: match[2].toUpperCase(),
    };
  }
  return null;
}

// テキストを正規化（全角→半角）
function normalizeText(text: string): string {
  return text
    .replace(/[０-９]/g, (match) => String.fromCharCode(match.charCodeAt(0) - 0xFEE0))
    .replace(/[ａ-ｚ]/g, (match) => String.fromCharCode(match.charCodeAt(0) - 0xFEE0))
    .replace(/[Ａ-Ｚ]/g, (match) => String.fromCharCode(match.charCodeAt(0) - 0xFEE0))
    .replace(/[、，]/g, ',')
    .replace(/ｈ/g, 'h');
}

// 時数をパース（1-6h）
function parsePeriods(text: string): number[] {
  const normalized = normalizeText(text);
  const periods: number[] = [];
  
  // パターン1: 「1h」「2h」などの個別表記
  const singleMatches = normalized.match(/([1-6])\s*h/gi);
  if (singleMatches) {
    singleMatches.forEach(match => {
      const num = parseInt(match.match(/[1-6]/)![0]);
      if (!periods.includes(num)) {
        periods.push(num);
      }
    });
  }
  
  // パターン2: 「3,4」などの複数表記
  const multiMatches = normalized.match(/([1-6])[,、]([1-6])/g);
  if (multiMatches) {
    multiMatches.forEach(match => {
      const nums = match.match(/[1-6]/g);
      if (nums) {
        nums.forEach(n => {
          const num = parseInt(n);
          if (!periods.includes(num)) {
            periods.push(num);
          }
        });
      }
    });
  }
  
  return periods.sort((a, b) => a - b);
}

// 日付をパース（2月18日 → 2026-02-18）
function parseDate(text: string, year: number = 2026): string | null {
  const normalized = normalizeText(text);
  const match = normalized.match(/(\d{1,2})月(\d{1,2})日/);
  if (match) {
    const month = parseInt(match[1]).toString().padStart(2, '0');
    const day = parseInt(match[2]).toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null;
}

function extractClassPeriodSubjectChanges(text: string, date: string): Change[] {
  const normalized = normalizeText(text)
    .replace(/\s+/g, ' ')
    .trim();

  const withoutDate = normalized
    .replace(/^\d{1,2}月\d{1,2}日（[^）]+）\s*/, '')
    .trim();

  const segmentedChanges: Change[] = [];
  const segmentPattern = /([123][FM])\s*([1-6])\s*h\s*(.*?)(?=(?:[123][FM]\s*[1-6]\s*h)|$)/g;

  let match: RegExpExecArray | null;
  while ((match = segmentPattern.exec(withoutDate)) !== null) {
    const classInfo = parseClass(match[1]);
    const period = parseInt(match[2], 10);
    const subject = match[3].trim().replace(/\s+/g, ' ');

    if (!classInfo || !subject) {
      continue;
    }

    segmentedChanges.push({
      date,
      classes: [classInfo],
      periods: [period],
      subject,
      description: text,
    });
  }

  return segmentedChanges;
}

function toWebappChanges(data: FormattedData): WebappChange[] {
  const changes: WebappChange[] = [];

  data.changes.forEach((change) => {
    const classes = change.classes || [];
    const periods = change.periods || [];

    classes.forEach((classInfo) => {
      const classYear = `${classInfo.year}${classInfo.type}`;

      if (periods.length === 1 && periods[0] === 0) {
        for (let p = 0; p <= 6; p++) {
          changes.push({
            date: change.date,
            classYear,
            period: p,
            day: '',
            newSubject: change.subject,
            description: change.description,
          });
        }
        return;
      }

      periods.forEach((period) => {
        changes.push({
          date: change.date,
          classYear,
          period: period - 1,
          day: '',
          newSubject: change.subject,
          description: change.description,
        });
      });
    });
  });

  return changes;
}

// データを整形
function formatData(rawData: RawFormData): FormattedData {
  const changes: Change[] = [];
  const errors: string[] = [];
  const rawItems = rawData.items.map(item => ({ title: item.title }));

  rawData.items.forEach((item, index) => {
    const text = item.title;
    const normalized = normalizeText(text);
    
    // 日付を抽出
    const date = parseDate(text);
    if (!date) {
      console.log(`  ⊘ スキップ（日付なし）: ${text.substring(0, 50)}...`);
      return; // 日付がない場合はスキップ
    }

    const segmentedChanges = extractClassPeriodSubjectChanges(text, date);
    if (segmentedChanges.length > 0) {
      changes.push(...segmentedChanges);
      return;
    }

    // クラスを抽出（正規化後のテキストで検索）
    const classMatches = normalized.match(/([123])[\/\s]?([FM])/gi);
    const classes: ClassInfo[] = [];
    
    if (classMatches) {
      classMatches.forEach(classText => {
        const classInfo = parseClass(classText);
        if (classInfo) {
          // 重複を避ける
          if (!classes.find(c => c.year === classInfo.year && c.type === classInfo.type)) {
            classes.push(classInfo);
          }
        }
      });
    }
    
    // 全学年の場合または全校行事の場合
    if (text.includes('全学年') || 
        text.includes('卒業式') || 
        text.includes('全校') ||
        (classes.length === 0 && 
         (text.includes('進路') || text.includes('式典') || text.includes('行事')))) {
      classes.length = 0; // クリア
      classes.push(
        { year: '1', type: 'F' },
        { year: '1', type: 'M' },
        { year: '2', type: 'F' },
        { year: '2', type: 'M' },
        { year: '3', type: 'F' },
        { year: '3', type: 'M' }
      );
    }

    if (classes.length === 0) {
      console.log(`  ⊘ スキップ（クラス不明）: ${text.substring(0, 50)}...`);
      return;
    }

    // 時数を抽出
    const periods = parsePeriods(text);
    
    // 科目を抽出（最後の部分を使用）
    let subject = '';
    if (text.includes('自宅学習')) {
      subject = '自宅学習';
    } else if (text.includes('進路ガイダンス')) {
      subject = '進路ガイダンス';
    } else if (text.includes('卒業式予行')) {
      subject = '卒業式予行';
    } else if (text.includes('卒業式')) {
      subject = '卒業式';
    } else if (text.includes('ＬＨＲ') || text.includes('LHR')) {
      subject = 'LHR';
    } else {
      // 最後の単語を科目名として使用
      const words = text.split(/[\s　]/);
      subject = words[words.length - 1] || 'その他';
    }

    changes.push({
      date,
      classes,
      periods: periods.length > 0 ? periods : [0], // デフォルト: 1時限(内部的に0から始まるため)
      subject,
      description: text,
    });
  });

  return {
    title: rawData.title,
    fetchedAt: new Date().toISOString(),
    changes,
    rawItems, // デバッグ用
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function saveFormData(data: FormattedData) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `form_data_${timestamp}.json`;
  const filepath = path.join(OUTPUT_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✓ 整形データを保存しました: ${filepath}`);

  // 最新データとして別途保存
  const latestPath = path.join(OUTPUT_DIR, 'latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✓ 最新データを更新しました: ${latestPath}`);

  const webappChanges = toWebappChanges(data);
  const webappPublicPath = path.join(process.cwd(), 'webapp', 'public', 'changes.json');
  fs.mkdirSync(path.dirname(webappPublicPath), { recursive: true });
  fs.writeFileSync(webappPublicPath, JSON.stringify(webappChanges, null, 2), 'utf8');
  console.log(`✓ Webアプリ公開データを更新しました: ${webappPublicPath}`);

  const webappOutDir = path.join(process.cwd(), 'webapp', 'out');
  if (fs.existsSync(webappOutDir)) {
    const webappOutPath = path.join(webappOutDir, 'changes.json');
    fs.writeFileSync(webappOutPath, JSON.stringify(webappChanges, null, 2), 'utf8');
    console.log(`✓ 配信用データを更新しました: ${webappOutPath}`);
  }
}

async function main() {
  try {
    console.log('📥 Googleフォームからデータを取得中...');
    const rawData = await fetchFormData();
    console.log(`✓ フォームタイトル: ${rawData.title}`);
    console.log(`✓ 設問数: ${rawData.items.length}`);
    
    console.log('\n🔄 データを整形中...');
    const formattedData = formatData(rawData);
    console.log(`✓ 抽出された授業変更: ${formattedData.changes.length}件`);
    
    formattedData.changes.forEach((change, index) => {
      const classStr = change.classes.map(c => `${c.year}/${c.type}`).join(', ');
      const periodStr = change.periods.map(p => `${p}h`).join(', ');
      console.log(`  ${index + 1}. ${change.date} - ${classStr} ${periodStr} → ${change.subject}`);
    });
    
    console.log('\n💾 データを保存中...');
    await saveFormData(formattedData);
    
    console.log('\n✅ 処理が完了しました！');
  } catch (error: any) {
    console.error('❌ エラーが発生しました:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { fetchFormData, formatData, saveFormData };
