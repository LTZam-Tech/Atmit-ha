namespace Atimtha.Api.Execution;

/// <summary>
/// Standard 5-field cron (minute hour day-of-month month day-of-week) with <c>*</c>, lists, ranges and steps,
/// day-of-week 0–7 (0 and 7 = Sunday) and the usual rule: when both day fields are restricted, either may match.
/// Times are wall-clock times in the schedule's time zone; a time skipped by a daylight-saving change is skipped.
/// </summary>
public sealed class Cron
{
    private readonly bool[] minutes = new bool[60], hours = new bool[24], days = new bool[32], months = new bool[13], weekdays = new bool[7];
    private readonly bool anyDay, anyWeekday;

    private Cron(string[] f)
    {
        Fill(f[0], 0, 59, minutes);
        Fill(f[1], 0, 23, hours);
        anyDay = Fill(f[2], 1, 31, days);
        Fill(f[3], 1, 12, months);
        var dow = new bool[8];
        anyWeekday = Fill(f[4], 0, 7, dow);
        for (var i = 0; i < 7; i++) weekdays[i] = dow[i];
        if (dow[7]) weekdays[0] = true;
    }

    public static bool TryParse(string? expression, out Cron? cron, out string? error)
    {
        cron = null;
        error = null;
        var fields = (expression ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length != 5) { error = "Use 5 fields: minute hour day-of-month month day-of-week."; return false; }
        try { cron = new Cron(fields); return true; }
        catch (FormatException e) { error = e.Message; return false; }
    }

    /// <summary>The first occurrence strictly after <paramref name="after"/>, or null within the next 5 years.</summary>
    public DateTimeOffset? Next(DateTimeOffset after, TimeZoneInfo zone)
    {
        var local = TimeZoneInfo.ConvertTime(after, zone).DateTime;
        var t = new DateTime(local.Year, local.Month, local.Day, local.Hour, local.Minute, 0, DateTimeKind.Unspecified).AddMinutes(1);
        var limit = t.AddYears(5);
        while (t < limit)
        {
            if (!months[t.Month]) { t = new DateTime(t.Year, t.Month, 1).AddMonths(1); continue; }
            if (!DayMatches(t)) { t = t.Date.AddDays(1); continue; }
            if (!hours[t.Hour]) { t = t.Date.AddHours(t.Hour + 1); continue; }
            if (!minutes[t.Minute]) { t = t.AddMinutes(1); continue; }
            if (!zone.IsInvalidTime(t)) return new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(t, zone), TimeSpan.Zero);
            t = t.AddMinutes(1);
        }
        return null;
    }

    private bool DayMatches(DateTime t)
    {
        var d = days[t.Day];
        var w = weekdays[(int)t.DayOfWeek];
        if (anyDay && anyWeekday) return true;
        if (anyDay) return w;
        if (anyWeekday) return d;
        return d || w;
    }

    /// <returns>true when the field is "*" (unrestricted)</returns>
    private static bool Fill(string field, int lo, int hi, bool[] set)
    {
        var unrestricted = field == "*";
        foreach (var part in field.Split(','))
        {
            var (range, step) = part.Split('/') is [var r, var s]
                ? (r, int.TryParse(s, out var n) && n > 0 ? n : throw new FormatException($"Bad step in \"{field}\"."))
                : (part, 1);
            int from, to;
            if (range == "*") (from, to) = (lo, hi);
            else if (range.Split('-') is [var a, var b]) (from, to) = (Num(a, lo, hi, field), Num(b, lo, hi, field));
            else { from = Num(range, lo, hi, field); to = step > 1 ? hi : from; }
            if (from > to) throw new FormatException($"Bad range in \"{field}\".");
            for (var i = from; i <= to; i += step) set[i] = true;
        }
        return unrestricted;
    }

    private static int Num(string s, int lo, int hi, string field) =>
        int.TryParse(s, out var n) && n >= lo && n <= hi ? n : throw new FormatException($"\"{field}\": use numbers from {lo} to {hi}.");
}
