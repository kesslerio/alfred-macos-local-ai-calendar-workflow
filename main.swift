import EventKit
import Foundation

let eventStore = EKEventStore()

func requestAccessSync() -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var isGranted = false
    
    if #available(macOS 14.0, *) {
        eventStore.requestFullAccessToEvents { granted, error in
            isGranted = granted
            semaphore.signal()
        }
    } else {
        eventStore.requestAccess(to: .event) { granted, error in
            isGranted = granted
            semaphore.signal()
        }
    }
    
    _ = semaphore.wait(timeout: .distantFuture)
    return isGranted
}

func findCalendar(name: String) -> EKCalendar? {
    let calendars = eventStore.calendars(for: .event)
    return calendars.first { $0.title.lowercased() == name.lowercased() }
}

func parseISO8601Date(string: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: string) {
        return date
    }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: string)
}

// Parse argv after the subcommand into --flag/value pairs in a single
// left-to-right pass. This prevents a value that happens to look like a flag
// (e.g. a title of "--calendar") from being mis-detected as a flag and swapping
// field values, which a naive firstIndex(of:) lookup would allow.
let parsedArgs: [String: String] = {
    var result: [String: String] = [:]
    let args = CommandLine.arguments
    var i = 2 // skip executable path (0) and subcommand (1)
    while i < args.count {
        let token = args[i]
        if token.hasPrefix("--"), i + 1 < args.count {
            result[token] = args[i + 1]
            i += 2
        } else {
            i += 1
        }
    }
    return result
}()

func getArgValue(flag: String) -> String? {
    return parsedArgs[flag]
}

func printJSON(_ obj: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let jsonString = String(data: data, encoding: .utf8) {
        print(jsonString)
    } else {
        print("[]")
    }
}

// MAIN EXECUTION
func main() {
    let args = CommandLine.arguments
    guard args.count > 1 else {
        print("Usage: local-calendar-helper [create|search|delete|update] [options]")
        exit(1)
    }
    
    let command = args[1]
    
    switch command {
    case "create":
        guard let title = getArgValue(flag: "--title"),
              let startStr = getArgValue(flag: "--start"),
              let endStr = getArgValue(flag: "--end"),
              let calendarName = getArgValue(flag: "--calendar") else {
            print("Error: Missing required arguments for create. Needs --title, --start, --end, --calendar")
            exit(1)
        }
        
        guard let startDate = parseISO8601Date(string: startStr),
              let endDate = parseISO8601Date(string: endStr) else {
            print("Error: Invalid date formats.")
            exit(1)
        }
        
        guard requestAccessSync() else {
            print("Error: Access denied.")
            exit(1)
        }
        
        let calendar = findCalendar(name: calendarName) ?? eventStore.defaultCalendarForNewEvents
        guard let targetCalendar = calendar else {
            print("Error: Target calendar not found and no default available.")
            exit(1)
        }
        
        let event = EKEvent(eventStore: eventStore)
        event.title = title
        event.startDate = startDate
        event.endDate = endDate
        event.calendar = targetCalendar
        
        if let location = getArgValue(flag: "--location") {
            event.location = location
        }
        if let urlStr = getArgValue(flag: "--url"), let url = URL(string: urlStr) {
            event.url = url
        }
        if let notes = getArgValue(flag: "--notes") {
            event.notes = notes
        }
        
        if let freqStr = getArgValue(flag: "--recurrence-frequency") {
            var frequency: EKRecurrenceFrequency? = nil
            switch freqStr.lowercased() {
            case "daily": frequency = .daily
            case "weekly": frequency = .weekly
            case "monthly": frequency = .monthly
            case "yearly": frequency = .yearly
            default: break
            }
            
            if let freq = frequency {
                var interval = 1
                if let intervalStr = getArgValue(flag: "--recurrence-interval"), let val = Int(intervalStr) {
                    interval = val
                }
                
                var daysOfTheWeek: [EKRecurrenceDayOfWeek]? = nil
                if let daysStr = getArgValue(flag: "--recurrence-days") {
                    let daysList = daysStr.components(separatedBy: ",")
                    daysOfTheWeek = daysList.compactMap { dayName -> EKRecurrenceDayOfWeek? in
                        let d = dayName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                        switch d {
                        case "monday", "mon": return EKRecurrenceDayOfWeek(.monday)
                        case "tuesday", "tue": return EKRecurrenceDayOfWeek(.tuesday)
                        case "wednesday", "wed": return EKRecurrenceDayOfWeek(.wednesday)
                        case "thursday", "thu": return EKRecurrenceDayOfWeek(.thursday)
                        case "friday", "fri": return EKRecurrenceDayOfWeek(.friday)
                        case "saturday", "sat": return EKRecurrenceDayOfWeek(.saturday)
                        case "sunday", "sun": return EKRecurrenceDayOfWeek(.sunday)
                        default: return nil
                        }
                    }
                }
                
                let rule = EKRecurrenceRule(
                    recurrenceWith: freq,
                    interval: interval,
                    daysOfTheWeek: daysOfTheWeek,
                    daysOfTheMonth: nil,
                    monthsOfTheYear: nil,
                    weeksOfTheYear: nil,
                    daysOfTheYear: nil,
                    setPositions: nil,
                    end: nil
                )
                event.recurrenceRules = [rule]
            }
        }
        
        do {
            try eventStore.save(event, span: .thisEvent)
            print("Success: Added '\(title)' to '\(targetCalendar.title)' (ID: \(event.eventIdentifier ?? ""))")
        } catch {
            print("Error: Failed to save event: \(error.localizedDescription)")
            exit(1)
        }
        
    case "search":
        let query = getArgValue(flag: "--query") ?? ""
        let startStr = getArgValue(flag: "--start")
        let endStr = getArgValue(flag: "--end")
        
        var startDate = Date().addingTimeInterval(-86400 * 7) // 7 days ago default
        var endDate = Date().addingTimeInterval(86400 * 30)   // 30 days future default
        
        if let startStr = startStr, let d = parseISO8601Date(string: startStr) {
            startDate = d
        }
        if let endStr = endStr, let d = parseISO8601Date(string: endStr) {
            endDate = d
        }
        
        guard requestAccessSync() else {
            print("[]")
            exit(1)
        }
        
        let predicate = eventStore.predicateForEvents(withStart: startDate, end: endDate, calendars: nil)
        let events = eventStore.events(matching: predicate)
        
        let filtered = events.filter { event in
            if query.isEmpty { return true }
            guard let title = event.title else { return false }
            return title.lowercased().contains(query.lowercased())
        }
        
        let results = filtered.map { event -> [String: String] in
            return [
                "id": event.eventIdentifier ?? "",
                "title": event.title ?? "",
                "start_date": ISO8601DateFormatter().string(from: event.startDate),
                "end_date": ISO8601DateFormatter().string(from: event.endDate),
                "calendar": event.calendar?.title ?? "",
                "location": event.location ?? "",
                "notes": event.notes ?? "",
                "url": event.url?.absoluteString ?? ""
            ]
        }
        printJSON(results)
        
    case "delete":
        guard let id = getArgValue(flag: "--id") else {
            print("Error: Missing --id")
            exit(1)
        }
        
        guard requestAccessSync() else {
            print("Error: Access denied.")
            exit(1)
        }
        
        guard let event = eventStore.event(withIdentifier: id) else {
            print("Error: Event not found.")
            exit(1)
        }
        
        do {
            try eventStore.remove(event, span: .thisEvent)
            print("Success: Deleted event '\(event.title ?? "")'")
        } catch {
            print("Error: Failed to delete: \(error.localizedDescription)")
            exit(1)
        }
        
    case "update":
        guard let id = getArgValue(flag: "--id") else {
            print("Error: Missing --id")
            exit(1)
        }
        
        guard requestAccessSync() else {
            print("Error: Access denied.")
            exit(1)
        }
        
        guard let event = eventStore.event(withIdentifier: id) else {
            print("Error: Event not found.")
            exit(1)
        }
        
        if let title = getArgValue(flag: "--title") {
            event.title = title
        }
        if let startStr = getArgValue(flag: "--start"), let d = parseISO8601Date(string: startStr) {
            event.startDate = d
        }
        if let endStr = getArgValue(flag: "--end"), let d = parseISO8601Date(string: endStr) {
            event.endDate = d
        }
        if let calendarName = getArgValue(flag: "--calendar"), let cal = findCalendar(name: calendarName) {
            event.calendar = cal
        }
        if let location = getArgValue(flag: "--location") {
            event.location = location
        }
        if let urlStr = getArgValue(flag: "--url") {
            event.url = urlStr.isEmpty ? nil : URL(string: urlStr)
        }
        if let notes = getArgValue(flag: "--notes") {
            event.notes = notes
        }
        
        if let freqStr = getArgValue(flag: "--recurrence-frequency") {
            var frequency: EKRecurrenceFrequency? = nil
            switch freqStr.lowercased() {
            case "daily": frequency = .daily
            case "weekly": frequency = .weekly
            case "monthly": frequency = .monthly
            case "yearly": frequency = .yearly
            case "none", "clear", "":
                event.recurrenceRules = nil
            default: break
            }
            
            if let freq = frequency {
                var interval = 1
                if let intervalStr = getArgValue(flag: "--recurrence-interval"), let val = Int(intervalStr) {
                    interval = val
                }
                
                var daysOfTheWeek: [EKRecurrenceDayOfWeek]? = nil
                if let daysStr = getArgValue(flag: "--recurrence-days") {
                    let daysList = daysStr.components(separatedBy: ",")
                    daysOfTheWeek = daysList.compactMap { dayName -> EKRecurrenceDayOfWeek? in
                        let d = dayName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                        switch d {
                        case "monday", "mon": return EKRecurrenceDayOfWeek(.monday)
                        case "tuesday", "tue": return EKRecurrenceDayOfWeek(.tuesday)
                        case "wednesday", "wed": return EKRecurrenceDayOfWeek(.wednesday)
                        case "thursday", "thu": return EKRecurrenceDayOfWeek(.thursday)
                        case "friday", "fri": return EKRecurrenceDayOfWeek(.friday)
                        case "saturday", "sat": return EKRecurrenceDayOfWeek(.saturday)
                        case "sunday", "sun": return EKRecurrenceDayOfWeek(.sunday)
                        default: return nil
                        }
                    }
                }
                
                let rule = EKRecurrenceRule(
                    recurrenceWith: freq,
                    interval: interval,
                    daysOfTheWeek: daysOfTheWeek,
                    daysOfTheMonth: nil,
                    monthsOfTheYear: nil,
                    weeksOfTheYear: nil,
                    daysOfTheYear: nil,
                    setPositions: nil,
                    end: nil
                )
                event.recurrenceRules = [rule]
            }
        }
        
        do {
            try eventStore.save(event, span: .thisEvent)
            print("Success: Updated event '\(event.title ?? "")'")
        } catch {
            print("Error: Failed to update: \(error.localizedDescription)")
            exit(1)
        }
        
    default:
        print("Error: Unknown command '\(command)'")
        exit(1)
    }
}

main()
